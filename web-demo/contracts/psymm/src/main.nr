mod config;
mod custody;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use dep::aztec::{
        context::UtilityContext,
        macros::{
            functions::{initializer, private, public, view, utility, internal},
            storage::storage,
        },
        prelude::{AztecAddress, Map, PrivateSet, PublicImmutable},
        note::note_viewer_options::NoteViewerOptions,
        protocol_types::traits::{FromField, ToField}
    };

    use dep::token::Token;

    use crate::config::Config;
    use crate::custody::{Custody, DepositNote};

    use std::hash::poseidon2::Poseidon2::hash;

    global MAX_PARTIES: u32 = 2;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// custody_id -> N*N of notes (N deposit notes with N owners)
        custody_map: Map<Field, Custody<Context>, Context>,
    }

    /// Initialize with the L2 token address
    #[public]
    #[initializer]
    fn constructor(token: AztecAddress) {
        storage.config.initialize(Config { token });
    }


    /// Read-only view of the contract config
    #[private]
    #[view]
    fn get_config() -> Config {
        storage.config.read()
    }

    #[private]
    fn custody_balance(custody_id: Field) -> Field {
        storage.custody_map.at(custody_id).get_balance(context.msg_sender())
    }

    #[private]
    fn custody_balance_from(custody_id: Field, party: AztecAddress) -> Field {
        storage.custody_map.at(custody_id).get_balance_from(context.msg_sender(), party)
    }


    #[private]
    fn address_to_custody(
        custody_id: Field,
        parties: [AztecAddress; MAX_PARTIES],
        sender_idx: u32,
        amount: u64, 
        nonce: Field
    ) {
        let mut fields = [0; MAX_PARTIES];
        for i in 0..MAX_PARTIES {
            fields[i] = parties[i].to_field();
        }
        let computed_id = hash(fields, MAX_PARTIES);
        assert(custody_id == computed_id);

        assert(parties[sender_idx].eq(context.msg_sender()));
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_to_public(parties[sender_idx], context.this_address(), amount as u128, nonce)
            .call(&mut context);

        for i in 0..MAX_PARTIES {
            storage.custody_map.at(custody_id).add_deposit(amount, parties[sender_idx], parties[i]);
        }
    }

    #[private]
    fn approve_withdrawal(
        to: AztecAddress,
        custody_id: Field,
        amount: u64,
        nonce: Field
    ) {
        storage.custody_map.at(custody_id).add_withdraw_confirm(
            to,
            custody_id,
            amount as Field,
            nonce,
            context.msg_sender()
        );
    }

    #[private]
    fn custody_to_address(
        custody_id: Field,
        parties: [AztecAddress; MAX_PARTIES],
        receiver_idx: u32,
        amount: u64,
        nonce: Field
    ) {
        // Check total custody balance is positive before withdrawal
        let receiver = parties[receiver_idx];
        let total_balance = storage.custody_map.at(custody_id).get_balance(receiver);
        assert(total_balance as u128 > 0);

        let mut fields = [0; MAX_PARTIES];
        for i in 0..MAX_PARTIES {
            fields[i] = parties[i].to_field();
        }
        let computed_id = hash(fields, MAX_PARTIES);
        assert(custody_id == computed_id);
        let receiver = parties[receiver_idx];
        storage.custody_map.at(custody_id).add_withdrawal(amount, receiver, receiver);
        
        for i in 0..MAX_PARTIES {
            if i != receiver_idx {
                assert(
                    storage.custody_map.at(custody_id).has_withdraw_confirm(
                        receiver,
                        custody_id,
                        amount as Field,
                        nonce,
                        parties[i]
                    )
                );
                storage.custody_map.at(custody_id).add_withdrawal(amount, receiver, parties[i]);
            }
        }

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_public(context.this_address(), receiver, amount as u128, 0)
            .enqueue(&mut context);

    }
}
