mod config;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use dep::aztec::{
        context::PrivateContext,
        macros::{
            functions::{initializer, private, public, view, utility},
            storage::storage,
        },
        messages::logs::{
            event::encode_and_encrypt_event_unconstrained,
            note::{encode_and_encrypt_note, encode_and_encrypt_note_unconstrained},
        },
        prelude::{AztecAddress, Map, PrivateSet, PublicImmutable},
        note::note_interface::{NoteHash, NoteProperties},
        utils::comparison::Comparator,
    };

    use dep::token::Token;
    use dep::types::traits::FromField;
    use dep::easy_private_state::EasyPrivateUint;
    use dep::value_note::balance_utils;


    use crate::config::Config;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// custody_id -> N*N of notes (N deposit notes with N owners)
        custody_balances: Map<Field, EasyPrivateUint<Context>, Context>,
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

    #[utility]
    unconstrained fn custody_balance(custody_id: Field) -> Field {
        let balances = storage.custody_balances;

        balance_utils::get_balance(balances.at(custody_id).set)
    }

    #[private]
    fn address_to_custody(from: AztecAddress, custody_id: Field, amount: u64, nonce: Field) {
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_to_public(from, context.this_address(), amount as u128, nonce)
            .call(&mut context);

        storage.custody_balances.at(custody_id).add(amount, context.msg_sender(), context.msg_sender());
    }

    #[private]
    fn custody_to_address(to: AztecAddress, custody_id: Field, amount: u64) {
        let custody_id_addr = AztecAddress::from_field(custody_id);
        storage.custody_balances.at(custody_id).sub(amount, context.msg_sender(), context.msg_sender());

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_public(context.this_address(), to, amount as u128, 0)
            .enqueue(&mut context);

    }
}
