mod config;
mod types;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    // Corrected imports based on usage
    use std::ops::{Add, Sub}; // Keep Add/Sub if BalanceSet methods return values needing them, otherwise remove. Re-evaluating: BalanceSet add/sub handle ops internally. Remove.

    use dep::aztec::{
        context::PrivateContext, // Keep PrivateContext as it's used in function signatures implicitly via #[private]
        macros::{
            functions::{initializer, private, public, view}, // Removed internal, utility
            storage::storage,
        },
        // Removed unused log imports
        prelude::{AztecAddress, Map, PublicImmutable}, // Removed PublicContext, PublicMutable
        // Removed unused Serialize import
    };

    // Removed unused uint_note imports
    use dep::token::Token;
    // Removed unused ToField import

    use crate::types::balance_set::BalanceSet;
    use crate::config::Config;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// Mapping of custody_id to private balance sets
        custody_balances: Map<Field, BalanceSet<Context>, Context>,
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

    /// Deposit `amount` of L2 token into private custody under `custody_id`
    #[private]
    fn deposit(custody_id: Field, amount: u128, nonce: Field) {
        let caller = context.msg_sender();
        let cfg = storage.config.read();

        Token::at(cfg.token)
            .transfer_in_private(caller, context.this_address(), amount, nonce)
            .call(&mut context);

        // 2) Update custody balance by adding a new note owned by the caller
        storage.custody_balances.at(custody_id).add(caller, amount);

        // 3) Emit an unconstrained note for off-chain indexing (Optional)
        // encode_and_encrypt_note_unconstrained(
        //     &mut context,
        //     caller, // Or perhaps context.this_address() depending on indexing needs
        //     custody_id, // Include custody_id in the note? Need a custom note type.
        // );
    }

    /// Withdraw `amount` of L2 token from private custody under `custody_id`
    #[private]
    fn withdraw(custody_id: Field, amount: u128) {
        let caller = context.msg_sender();

        storage.custody_balances.at(custody_id).sub(caller, amount);

        // 2) Transfer `amount` of L2 token back to caller (private)
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer(caller, amount)
            .call(&mut context);

        // 3) Emit an unconstrained note for off-chain indexing (Optional)
        // encode_and_encrypt_note_unconstrained(
        //     &mut context,
        //     caller, // Or perhaps context.this_address()
        //     custody_id, // Include custody_id?
        // );
    }
}
