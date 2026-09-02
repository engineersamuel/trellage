mod arch;
mod paren;
mod search;
mod verify;

pub use paren::find_matching_paren;
pub use search::{Backend, SearchOutcome, SortedI32, UnsortedAt};
pub use verify::{VerificationError, VerificationSummary, verify_accuracy};

pub fn selected_backend() -> Backend {
    arch::detect()
}
