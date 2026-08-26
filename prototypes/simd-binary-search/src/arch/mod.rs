use crate::search::{Backend, lower_bound_scalar, lower_bound_scalar_in_range};

#[cfg(target_arch = "aarch64")]
mod aarch64;
#[cfg(target_arch = "x86_64")]
mod x86_64;

pub(crate) struct KernelResult {
    pub lower_bound: usize,
    pub vector_steps: usize,
}

pub(crate) fn detect() -> Backend {
    #[cfg(target_arch = "aarch64")]
    {
        if aarch64::is_supported() {
            return Backend::Neon;
        }
    }
    #[cfg(target_arch = "x86_64")]
    {
        if x86_64::is_supported() {
            return Backend::Avx2;
        }
    }
    Backend::Scalar
}

pub(crate) fn lower_bound(values: &[i32], target: i32, backend: Backend) -> KernelResult {
    match backend {
        #[cfg(target_arch = "aarch64")]
        Backend::Neon => multiway_lower_bound::<4>(values, target, aarch64::count_less),
        #[cfg(target_arch = "x86_64")]
        Backend::Avx2 => multiway_lower_bound::<8>(values, target, x86_64::count_less),
        Backend::Scalar => scalar_kernel(values, target),
        #[cfg(not(target_arch = "aarch64"))]
        Backend::Neon => scalar_kernel(values, target),
        #[cfg(not(target_arch = "x86_64"))]
        Backend::Avx2 => scalar_kernel(values, target),
    }
}

fn scalar_kernel(values: &[i32], target: i32) -> KernelResult {
    KernelResult {
        lower_bound: lower_bound_scalar(values, target),
        vector_steps: 0,
    }
}

fn multiway_lower_bound<const LANES: usize>(
    values: &[i32],
    target: i32,
    count_less: fn(&[i32; LANES], i32) -> usize,
) -> KernelResult {
    let mut low = 0;
    let mut high = values.len();
    let mut vector_steps = 0;

    while high - low > LANES {
        let length = high - low;
        let pivot_indexes: [usize; LANES] = std::array::from_fn(|lane| {
            let rank = lane + 1;
            low + (length / (LANES + 1)) * rank + ((length % (LANES + 1)) * rank) / (LANES + 1)
        });
        let pivots = std::array::from_fn(|lane| values[pivot_indexes[lane]]);
        let passed = count_less(&pivots, target);
        vector_steps += 1;

        if passed == 0 {
            high = pivot_indexes[0];
            continue;
        }
        if passed == LANES {
            low = pivot_indexes[LANES - 1] + 1;
            continue;
        }
        low = pivot_indexes[passed - 1] + 1;
        high = pivot_indexes[passed];
    }

    KernelResult {
        lower_bound: lower_bound_scalar_in_range(values, target, low, high),
        vector_steps,
    }
}

#[cfg(test)]
mod tests {
    use super::{Backend, detect, lower_bound};

    #[test]
    fn detected_kernel_executes_vector_steps_for_a_large_input() {
        let values = (0..256).collect::<Vec<i32>>();
        let backend = detect();
        let result = lower_bound(&values, 173, backend);

        assert_eq!(result.lower_bound, 173);
        if backend != Backend::Scalar {
            assert!(result.vector_steps > 0);
        }
    }
}
