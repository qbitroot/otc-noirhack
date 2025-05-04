use dep::aztec::{
    context::PrivateContext,
    messages::logs::note::encode_and_encrypt_note,
    note::{
        retrieved_note::RetrievedNote,
        note_getter_options::NoteGetterOptions,
    },
    state_vars::{PrivateSet, storage::Storage},
    macros::notes::note,
    oracle::random::random,
    protocol_types::{
        address::AztecAddress,
        constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL,
        utils::field::full_field_less_than,
    },
};



#[note]
#[derive(Eq)]
pub struct DepositNote {
    deposit_owner: AztecAddress,
    deposit_amount: Field,
    owner: AztecAddress, // for decryption
    is_deposit: bool,    // true for deposits, false for withdrawals
    randomness: Field,
}

impl DepositNote {
    pub fn new(deposit_owner: AztecAddress, deposit_amount: Field, owner: AztecAddress, is_deposit: bool) -> Self {
        // Safety: We use the randomness to preserve the privacy of the note recipient by preventing brute-forcing,
        // so a malicious sender could use non-random values to make the note less private. But they already know
        // the full note pre-image anyway, and so the recipient already trusts them to not disclose this
        // information. We can therefore assume that the sender will cooperate in the random value generation.

        let randomness = unsafe { random() };

        DepositNote { deposit_owner, deposit_amount, owner, is_deposit, randomness }
    }

    pub fn deposit_owner(self) -> AztecAddress {
        self.deposit_owner
    }
    pub fn owner(self) -> AztecAddress {
        self.owner
    }
    pub fn deposit_amount(self) -> Field {
        self.deposit_amount
    }
    pub fn is_deposit(self) -> bool {
        self.is_deposit
    }
}


pub struct Custody<Context> {
    context: Context,
    set: PrivateSet<DepositNote, Context>,
}

// TODO(#13824): remove this impl once we allow structs to hold state variables.
impl<Context> Storage<1> for Custody<Context> {
    fn get_storage_slot(self) -> Field {
        self.set.get_storage_slot()
    }
}

impl<Context> Custody<Context> {
    pub fn new(context: Context, storage_slot: Field) -> Self {
        Custody { context, set: PrivateSet::new(context, storage_slot) }
    }
}

pub struct BalanceArgs {
    from: AztecAddress,
}

pub fn filter_notes_by_owner(
    notes: [Option<RetrievedNote<DepositNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    args: BalanceArgs,
) -> [Option<RetrievedNote<DepositNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    let mut selected = [Option::none(); MAX_NOTE_HASH_READ_REQUESTS_PER_CALL];

    for i in 0..notes.len() {
        if notes[i].is_some() {
            let retrieved_note = notes[i].unwrap_unchecked();
            if retrieved_note.note.owner().eq(args.from) {
                selected[i] = Option::some(retrieved_note);
            }
        }
    }

    selected
}

impl Custody<&mut PrivateContext> {
    pub fn add_deposit(self, amount: u64, deposit_owner: AztecAddress, owner: AztecAddress) {
        let note = DepositNote::new(deposit_owner, amount as Field, owner, true);
        self.set.insert(note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    pub fn add_withdrawal(self, amount: u64, deposit_owner: AztecAddress, owner: AztecAddress) {
        let note = DepositNote::new(deposit_owner, amount as Field, owner, false);
        self.set.insert(note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    pub fn get_balance(self, from: AztecAddress) -> Field {
        let mut balance = 0;
        let mut options = NoteGetterOptions::with_filter(filter_notes_by_owner, BalanceArgs { from });
        let notes = self.set.get_notes(options);
        
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                if note.is_deposit() {
                    balance += note.deposit_amount();
                } else {
                    balance -= note.deposit_amount();
                }
            }
        }
        
        balance
    }

    pub fn get_balance_from(self, from: AztecAddress, deposit_owner: AztecAddress) -> Field {
        let mut balance = 0;
        let mut options = NoteGetterOptions::with_filter(filter_notes_by_owner, BalanceArgs { from });
        let notes = self.set.get_notes(options);
        
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                if note.deposit_owner().eq(deposit_owner) {
                    if note.is_deposit() {
                        balance += note.deposit_amount();
                    } else {
                        balance -= note.deposit_amount();
                    }
                }
            }
        }
        
        balance
    }
}

