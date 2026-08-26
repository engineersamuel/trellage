use std::collections::BTreeSet;
use std::fmt;

use crate::search::{Backend, SearchOutcome, outcome_from_lower_bound, search};

const EXHAUSTIVE_VALUES: [i32; 5] = [-2, -1, 0, 1, 2];
const GENERATED_CASES: usize = 512;
const SEED: u64 = 0x7a6c_4d91_2f83_b5e1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerificationSummary {
    pub backend: Backend,
    pub cases: usize,
    pub queries: usize,
    pub vector_queries: usize,
}

#[derive(Debug)]
pub enum VerificationError {
    WrongBackend {
        expected: Backend,
        actual: Backend,
    },
    NoVectorExecution {
        backend: Backend,
    },
    Mismatch {
        case: usize,
        values: Vec<i32>,
        target: i32,
        expected: SearchOutcome,
        actual: SearchOutcome,
        backend: Backend,
    },
}

impl fmt::Display for VerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongBackend { expected, actual } => {
                write!(formatter, "expected backend {expected}, detected {actual}")
            }
            Self::NoVectorExecution { backend } => {
                write!(formatter, "backend {backend} executed no vector queries")
            }
            Self::Mismatch {
                case,
                values,
                target,
                expected,
                actual,
                backend,
            } => write!(
                formatter,
                "case={case} values={values:?} target={target} expected={expected:?} actual={actual:?} backend={backend}"
            ),
        }
    }
}

impl std::error::Error for VerificationError {}

pub fn verify_accuracy() -> Result<VerificationSummary, VerificationError> {
    let backend = crate::selected_backend();
    require_matching_backend(backend)?;

    let mut state = VerificationState {
        cases: 0,
        queries: 0,
        vector_queries: 0,
    };

    let mut exhaustive = Vec::new();
    for length in 0..=10 {
        generate_exhaustive(length, 0, &mut Vec::new(), &mut exhaustive);
    }
    for values in exhaustive {
        state.check_case(&values, -3..=3)?;
    }

    for values in fixed_cases() {
        let targets = targets_for(&values, &mut SplitMix64::new(SEED ^ state.cases as u64));
        state.check_case(&values, targets)?;
    }

    let mut random = SplitMix64::new(SEED);
    for _ in 0..GENERATED_CASES {
        let values = generated_case(&mut random);
        let targets = targets_for(&values, &mut random);
        state.check_case(&values, targets)?;
    }

    if backend != Backend::Scalar && state.vector_queries == 0 {
        return Err(VerificationError::NoVectorExecution { backend });
    }

    Ok(VerificationSummary {
        backend,
        cases: state.cases,
        queries: state.queries,
        vector_queries: state.vector_queries,
    })
}

fn require_matching_backend(backend: Backend) -> Result<(), VerificationError> {
    #[cfg(target_arch = "aarch64")]
    if backend != Backend::Neon {
        return Err(VerificationError::WrongBackend {
            expected: Backend::Neon,
            actual: backend,
        });
    }

    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") && backend != Backend::Avx2 {
        return Err(VerificationError::WrongBackend {
            expected: Backend::Avx2,
            actual: backend,
        });
    }

    Ok(())
}

struct VerificationState {
    cases: usize,
    queries: usize,
    vector_queries: usize,
}

impl VerificationState {
    fn check_case(
        &mut self,
        values: &[i32],
        targets: impl IntoIterator<Item = i32>,
    ) -> Result<(), VerificationError> {
        let case = self.cases;
        self.cases += 1;
        for target in targets {
            self.queries += 1;
            let execution = search(values, target);
            if execution.vector_steps > 0 {
                self.vector_queries += 1;
            }
            let expected =
                outcome_from_lower_bound(values, target, linear_lower_bound(values, target));
            if execution.outcome != expected {
                return Err(VerificationError::Mismatch {
                    case,
                    values: values.to_vec(),
                    target,
                    expected,
                    actual: execution.outcome,
                    backend: execution.backend,
                });
            }
        }
        Ok(())
    }
}

fn linear_lower_bound(values: &[i32], target: i32) -> usize {
    values
        .iter()
        .position(|value| *value >= target)
        .unwrap_or(values.len())
}

fn generate_exhaustive(
    remaining: usize,
    first_value: usize,
    current: &mut Vec<i32>,
    cases: &mut Vec<Vec<i32>>,
) {
    if remaining == 0 {
        cases.push(current.clone());
        return;
    }

    for (index, value) in EXHAUSTIVE_VALUES.iter().enumerate().skip(first_value) {
        current.push(*value);
        generate_exhaustive(remaining - 1, index, current, cases);
        current.pop();
    }
}

fn fixed_cases() -> Vec<Vec<i32>> {
    vec![
        vec![],
        vec![0],
        vec![7; 33],
        vec![i32::MIN, i32::MIN, -1, 0, i32::MAX, i32::MAX],
        (0..4).collect(),
        (0..5).collect(),
        (0..8).collect(),
        (0..9).collect(),
        (0..31).map(|value| value / 3).collect(),
        (0..32).map(|value| value / 3).collect(),
        (0..33).map(|value| value / 3).collect(),
        (0..255).map(|value| value / 7).collect(),
        (0..256).map(|value| value / 7).collect(),
        (0..257).map(|value| value / 7).collect(),
    ]
}

fn targets_for(values: &[i32], random: &mut SplitMix64) -> Vec<i32> {
    let mut targets = BTreeSet::from([i32::MIN, i32::MAX]);
    for value in values.iter().copied() {
        targets.insert(value);
        if let Some(previous) = value.checked_sub(1) {
            targets.insert(previous);
        }
        if let Some(next) = value.checked_add(1) {
            targets.insert(next);
        }
    }
    for _ in 0..16 {
        targets.insert(random.next() as i32);
    }
    targets.into_iter().collect()
}

fn generated_case(random: &mut SplitMix64) -> Vec<i32> {
    let length = (random.next() % 258) as usize;
    let mut value = -10_000 + (random.next() % 1_000) as i32;
    let mut values = Vec::with_capacity(length);
    for _ in 0..length {
        value += (random.next() % 4) as i32;
        values.push(value);
    }
    values
}

struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::{linear_lower_bound, verify_accuracy};

    #[test]
    fn linear_oracle_handles_duplicate_boundaries() {
        assert_eq!(linear_lower_bound(&[1, 2, 2, 4], 2), 1);
        assert_eq!(linear_lower_bound(&[1, 2, 2, 4], 3), 3);
    }

    #[test]
    fn deterministic_corpus_matches_the_independent_oracle() {
        let summary = verify_accuracy().expect("verification succeeds");
        assert!(summary.cases > 3_000);
        assert!(summary.queries > 20_000);
    }
}
