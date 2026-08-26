use std::fmt;

use crate::arch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Backend {
    Neon,
    Avx2,
    Scalar,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Neon => "neon",
            Self::Avx2 => "avx2",
            Self::Scalar => "scalar",
        }
    }
}

impl fmt::Display for Backend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchOutcome {
    Found { first_index: usize },
    Missing { insertion_index: usize },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnsortedAt {
    pub index: usize,
    pub previous: i32,
    pub current: i32,
}

pub struct SortedI32<'a> {
    values: &'a [i32],
}

impl<'a> SortedI32<'a> {
    pub fn new(values: &'a [i32]) -> Result<Self, UnsortedAt> {
        if let Some((offset, pair)) = values
            .windows(2)
            .enumerate()
            .find(|(_, pair)| pair[0] > pair[1])
        {
            return Err(UnsortedAt {
                index: offset + 1,
                previous: pair[0],
                current: pair[1],
            });
        }

        Ok(Self { values })
    }

    pub fn find_first(&self, target: i32) -> SearchOutcome {
        search(self.values, target).outcome
    }
}

pub(crate) struct SearchExecution {
    pub backend: Backend,
    pub outcome: SearchOutcome,
    pub vector_steps: usize,
}

pub(crate) fn search(values: &[i32], target: i32) -> SearchExecution {
    let backend = arch::detect();
    let kernel = arch::lower_bound(values, target, backend);
    SearchExecution {
        backend,
        outcome: outcome_from_lower_bound(values, target, kernel.lower_bound),
        vector_steps: kernel.vector_steps,
    }
}

pub(crate) fn outcome_from_lower_bound(values: &[i32], target: i32, index: usize) -> SearchOutcome {
    if values.get(index) == Some(&target) {
        return SearchOutcome::Found { first_index: index };
    }

    SearchOutcome::Missing {
        insertion_index: index,
    }
}

pub(crate) fn lower_bound_scalar(values: &[i32], target: i32) -> usize {
    lower_bound_scalar_in_range(values, target, 0, values.len())
}

pub(crate) fn lower_bound_scalar_in_range(
    values: &[i32],
    target: i32,
    mut low: usize,
    mut high: usize,
) -> usize {
    while low < high {
        let middle = low + (high - low) / 2;
        if values[middle] < target {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[cfg(test)]
mod tests {
    use super::{SearchOutcome, SortedI32, UnsortedAt};

    #[test]
    fn duplicate_target_returns_its_first_index() {
        let values = [1, 2, 2, 2, 3];
        let sorted = SortedI32::new(&values).expect("sorted input");

        assert_eq!(
            sorted.find_first(2),
            SearchOutcome::Found { first_index: 1 }
        );
    }

    #[test]
    fn construction_rejects_the_first_inversion() {
        match SortedI32::new(&[1, 9, 4]) {
            Err(error) => assert_eq!(
                error,
                UnsortedAt {
                    index: 2,
                    previous: 9,
                    current: 4,
                }
            ),
            Ok(_) => panic!("unsorted input was accepted"),
        }
    }

    #[test]
    fn missing_target_returns_its_insertion_index() {
        let values = [i32::MIN, -1, 4, 4, i32::MAX];
        let sorted = SortedI32::new(&values).expect("sorted input");

        assert_eq!(
            sorted.find_first(3),
            SearchOutcome::Missing { insertion_index: 2 }
        );
    }
}
