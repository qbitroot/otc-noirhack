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
    use dep::token::types::balance_set::BalanceSet;
    use dep::types::traits::FromField;

    use crate::config::Config;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// AztecAddress is Field, custody_id is Field
        custody_balances: Map<AztecAddress, BalanceSet<Context>, Context>,
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
    pub(crate) unconstrained fn custody_balance(custody_id: AztecAddress) -> u128 {
        storage.custody_balances.at(custody_id).balance_of()
    }

    #[private]
    fn address_to_custody(from: AztecAddress, custody_id: Field, amount: u128, nonce: Field) {
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_private(from, context.this_address(), amount, nonce)
            .call(&mut context);

        let custody_id_addr = AztecAddress::from_field(custody_id);
        storage.custody_balances.at(custody_id_addr).add(custody_id_addr, amount).emit(encode_and_encrypt_note(&mut context, custody_id_addr, from));
    }

    #[private]
    fn custody_to_address(to: AztecAddress, custody_id: Field, amount: u128, nonce: Field) {
        let custody_id_addr = AztecAddress::from_field(custody_id);
        storage.custody_balances.at(custody_id_addr).sub(custody_id_addr, amount).emit(encode_and_encrypt_note(&mut context, custody_id_addr, to));

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_private(context.this_address(), to, amount, nonce)
            .call(&mut context);

    }
}
