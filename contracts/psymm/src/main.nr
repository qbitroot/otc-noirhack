mod config;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use crate::config::Config;

    use dep::aztec::prelude::{AztecAddress, PublicImmutable};

    use dep::token::Token;

    use dep::aztec::macros::{functions::{initializer, private, public, view}, storage::storage};

    // Storage structure, containing all storage, and specifying what slots they use.
    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
    }

    // Constructs the contract.
    #[public]
    #[initializer]
    fn constructor(token: AztecAddress) {
        storage.config.initialize(Config { token });
    }

    #[private]
    #[view]
    fn get_config() -> Config {
        storage.config.read()
    }

}
