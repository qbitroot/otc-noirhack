use dep::aztec::{
    context::PrivateContext,
    messages::logs::note::encode_and_encrypt_note,
    note::{
        retrieved_note::RetrievedNote,
        note_getter_options::NoteGetterOptions,
        note_interface::{NoteType, NoteHash}
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
pub struct WithdrawConfirmNote {
    owner: AztecAddress,      // The address that can withdraw (recipient)
    custody_id: Field,
    amount: Field,
    nonce: Field,
    party: AztecAddress,      // The address giving confirmation
    randomness: Field,
}

impl WithdrawConfirmNote {
    pub fn new(owner: AztecAddress, custody_id: Field, amount: Field, nonce: Field, party: AztecAddress) -> Self {
        let randomness = unsafe { random() };
        WithdrawConfirmNote { owner, custody_id, amount, nonce, party, randomness }
    }
}

#[note]
#[derive(Eq)]
pub struct DepositNote {
    party: AztecAddress,
    deposit_amount: Field,
    owner: AztecAddress, // view-only for decryption
    is_deposit: bool,    // true for deposits, false for withdrawals
    randomness: Field,   // prevent brute-forcing note
}

impl DepositNote {
    pub fn new(party: AztecAddress, deposit_amount: Field, owner: AztecAddress, is_deposit: bool) -> Self {
        // Safety: We use the randomness to preserve the privacy of the note recipient by preventing brute-forcing,
        // so a malicious sender could use non-random values to make the note less private. But they already know
        // the full note pre-image anyway, and so the recipient already trusts them to not disclose this
        // information. We can therefore assume that the sender will cooperate in the random value generation.

        let randomness = unsafe { random() };

        DepositNote { party, deposit_amount, owner, is_deposit, randomness }
    }

    pub fn party(self) -> AztecAddress {
        self.party
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
    withdraw_confirms: PrivateSet<WithdrawConfirmNote, Context>,
}

// TODO(#13824): remove this impl once we allow structs to hold state variables.
impl<Context> Storage<2> for Custody<Context> {
    fn get_storage_slot(self) -> Field {
        self.set.get_storage_slot() + self.withdraw_confirms.get_storage_slot()
    }
}

impl<Context> Custody<Context> {
    pub fn new(context: Context, storage_slot: Field) -> Self {
        Custody { 
            context, 
            set: PrivateSet::new(context, storage_slot),
            withdraw_confirms: PrivateSet::new(context, storage_slot + 1)
        }
    }
}


impl Custody<&mut PrivateContext> {
    pub fn add_deposit(self, amount: u128, party: AztecAddress, owner: AztecAddress) {
        let note = DepositNote::new(party, amount as Field, owner, true);
        self.set.insert(note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    pub fn add_withdrawal(self, amount: u128, party: AztecAddress, owner: AztecAddress) {
        let note = DepositNote::new(party, amount as Field, owner, false);
        self.set.insert(note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    pub fn get_balance(self, from: AztecAddress) -> Field {
        let mut balance = 0;
        let notes = self.set.get_notes(NoteGetterOptions::new());

        for i in 0..notes.max_len() {
            if i < notes.len() {
            let note = notes.get_unchecked(i).note;
                if note.owner().eq(from) {
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

    pub fn get_balance_from(self, from: AztecAddress, party: AztecAddress) -> Field {
        let mut balance = 0;
        let notes = self.set.get_notes(NoteGetterOptions::new());

        for i in 0..notes.max_len() {
            if i < notes.len() {
            let note = notes.get_unchecked(i).note;
                if note.owner().eq(from) & note.party().eq(party) {
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

    pub fn add_withdraw_confirm(self, owner: AztecAddress, custody_id: Field, amount: Field, nonce: Field, party: AztecAddress) {
        let note = WithdrawConfirmNote::new(owner, custody_id, amount, nonce, party);
        self.withdraw_confirms.insert(note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    pub fn has_withdraw_confirm(self, owner: AztecAddress, custody_id: Field, amount: Field, nonce: Field, party: AztecAddress) -> bool {
        let notes = self.withdraw_confirms.get_notes(NoteGetterOptions::new());
        let mut matches = 0;

        for i in 0..notes.max_len() {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                matches += if (note.custody_id == custody_id) &
                             (note.amount == amount) &
                             (note.nonce == nonce) &
                             note.party.eq(party) { 1 } else { 0 };
            }
        }
        matches > 0
    }
}

