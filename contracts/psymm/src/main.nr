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
    };

    use dep::token::Token;
    use dep::types::traits::FromField;
    use binary_merkle_root::binary_merkle_root;

    // use std::hash::poseidon2::Poseidon2::hash;

    use crate::config::Config;
    use crate::custody::{Custody, DepositNote};

    global MAX_COUNTERPARTIES: u32 = 3;
    global MAX_PPM_DEPTH: u32 = 2;

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
    fn custody_balance_from(custody_id: Field, deposit_owner: AztecAddress) -> Field {
        storage.custody_map.at(custody_id).get_balance_from(context.msg_sender(), deposit_owner)
    }


    #[private]
    fn address_to_custody(
        from: AztecAddress,
        // counterparties used to share note ownership
        counterparties: [AztecAddress; MAX_COUNTERPARTIES],
        custody_id: Field,
        amount: u64, nonce: Field
    ) {
        // assert from is sender
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_to_public(from, context.this_address(), amount as u128, nonce)
            .call(&mut context);

        storage.custody_map.at(custody_id).add_deposit(amount, from, from);
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_map.at(custody_id).add_deposit(amount, from, counterparties[i]);
            }
        }
    }

    #[private]
    fn custody_to_address(
        to: AztecAddress, counterparties: [AztecAddress; MAX_COUNTERPARTIES],
        custody_id: Field, amount: u64,
        // merkle_siblings: [Field; MAX_PPM_DEPTH],
        // merkle_indices: [Field; MAX_PPM_DEPTH]
    ) {
        storage.custody_map.at(custody_id).add_withdrawal(amount, to, to);
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_map.at(custody_id).add_withdrawal(amount, to, counterparties[i]);
            }
        }

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_public(context.this_address(), to, amount as u128, 0)
            .enqueue(&mut context);

    }
}
