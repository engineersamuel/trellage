use super::scalar;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Independent, obviously correct model of the contract, kept deliberately
/// naive so it cannot share a bug with the kernel under test.
fn naive_matching_paren(input: &[u8], open_index: usize) -> Option<usize> {
    if input.get(open_index) != Some(&OPEN) {
        return None;
    }

    let mut depth: usize = 0;
    for (offset, byte) in input.iter().enumerate().skip(open_index) {
        if *byte == OPEN {
            depth += 1;
        } else if *byte == CLOSE {
            depth -= 1;
            if depth == 0 {
                return Some(offset);
            }
        }
    }

    None
}

fn assert_matches_reference(input: &[u8], open_index: usize) {
    let scan = scalar::scan(input, open_index);
    let expected = naive_matching_paren(input, open_index);

    assert_eq!(scan.index, expected, "index {open_index} in {input:?}");
    assert_eq!(scan.vector_steps, 0, "scalar kernel is not vectorized");
}

fn assert_every_index_matches_reference(input: &[u8]) {
    let past_the_end = input.len() + 1;

    for open_index in 0..=past_the_end {
        assert_matches_reference(input, open_index);
    }
}

#[test]
fn the_scalar_kernel_matches_the_reference_on_handwritten_inputs() {
    assert_every_index_matches_reference(b"");
    assert_every_index_matches_reference(b"(");
    assert_every_index_matches_reference(b"()");
    assert_every_index_matches_reference(b"((()))");
    assert_every_index_matches_reference(b"(()())");
    assert_every_index_matches_reference(b"a()b");
    assert_every_index_matches_reference(b"(((");
    assert_every_index_matches_reference(b"())))");
    assert_every_index_matches_reference(b"(xxxxxxxxxxxxxxxx)");
    assert_every_index_matches_reference(br#"("\)" ; )"#);
}

#[test]
fn the_scalar_kernel_matches_the_reference_around_the_vector_boundaries() {
    for boundary in [16usize, 32, 64] {
        let shortest = boundary - 2;
        let longest = boundary + 2;

        for length in shortest..=longest {
            let mut input = vec![OPEN];
            input.extend(std::iter::repeat_n(b'x', length));
            input.push(CLOSE);

            assert_matches_reference(&input, 0);
        }
    }
}

/// Fixed-seed linear congruential generator so generated cases are identical on
/// every run and every machine.
struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        let stepped = self.state.wrapping_mul(6_364_136_223_846_793_005);
        self.state = stepped.wrapping_add(1_442_695_040_888_963_407);
        (self.state >> 33) as u32
    }

    fn below(&mut self, bound: u32) -> u32 {
        self.next_u32() % bound
    }
}

#[test]
fn the_scalar_kernel_matches_the_reference_on_generated_inputs() {
    let mut generator = Lcg::new(0x1234_5678_9ABC_DEF0);

    for _ in 0..200 {
        let length = generator.below(200) as usize;
        let open_weight = 5 + generator.below(40);
        let mut input = Vec::with_capacity(length);

        for _ in 0..length {
            let roll = generator.below(100);
            if roll < open_weight {
                input.push(OPEN);
            } else if roll < 2 * open_weight {
                input.push(CLOSE);
            } else {
                input.push(b'a' + (roll % 26) as u8);
            }
        }

        for open_index in 0..=input.len() {
            assert_matches_reference(&input, open_index);
        }
    }
}

// The NEON kernel is a private seam of this module, so it is exercised here
// rather than through the public matcher. Every assertion below is
// unconditional on aarch64: a scalar fallback is never accepted as proof that
// the vector kernel works.

/// Vector block width of the AArch64 NEON kernel, in bytes.
#[cfg(target_arch = "aarch64")]
const BLOCK: usize = 16;

#[cfg(target_arch = "aarch64")]
const FILLER: u8 = b'x';

/// `prefix` filler bytes, then a pair wrapping `inner` filler bytes, then
/// `suffix` filler bytes. The open parenthesis sits at index `prefix`.
#[cfg(target_arch = "aarch64")]
fn wrapped_pair(prefix: usize, inner: usize, suffix: usize) -> Vec<u8> {
    let mut bytes = vec![FILLER; prefix];
    bytes.push(OPEN);
    bytes.extend(std::iter::repeat_n(FILLER, inner));
    bytes.push(CLOSE);
    bytes.extend(std::iter::repeat_n(FILLER, suffix));
    bytes
}

#[cfg(target_arch = "aarch64")]
fn assert_neon_matches_reference(input: &[u8], open_index: usize) {
    let scan = super::neon::scan(input, open_index);
    let expected = naive_matching_paren(input, open_index);

    assert_eq!(scan.index, expected, "index {open_index} in {input:?}");
    assert!(
        scan.vector_steps <= input.len() / BLOCK + 1,
        "one vector step per {BLOCK}-byte block at most, \
         got {} for index {open_index} in a {}-byte input",
        scan.vector_steps,
        input.len(),
    );
}

#[cfg(target_arch = "aarch64")]
fn assert_every_index_matches_neon(input: &[u8]) {
    let past_the_end = input.len() + 1;

    for open_index in 0..=past_the_end {
        assert_neon_matches_reference(input, open_index);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn aarch64_dispatches_the_paren_matcher_onto_the_neon_backend() {
    assert_eq!(super::detect(), crate::search::Backend::Neon);
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_takes_vector_steps_past_the_first_block() {
    // One full block of ordinary bytes plus a tail, so the kernel has to enter
    // its vector loop before the match.
    let input = wrapped_pair(0, BLOCK + 5, 0);
    let scan = super::neon::scan(&input, 0);

    assert_eq!(scan.index, Some(BLOCK + 6));
    assert!(
        scan.vector_steps > 0,
        "the neon kernel ran no vector step on a {}-byte input",
        input.len(),
    );
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_takes_vector_steps_on_a_long_input() {
    let input = wrapped_pair(0, 4096, 0);
    let scan = super::neon::scan(&input, 0);

    assert_eq!(scan.index, Some(4097));
    assert!(
        scan.vector_steps > 0,
        "the neon kernel ran no vector step on a {}-byte input",
        input.len(),
    );
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_rejects_indexes_that_do_not_hold_an_open_paren() {
    assert_neon_matches_reference(b"", 0);
    assert_neon_matches_reference(b"", 7);
    assert_neon_matches_reference(b"()", 2);
    assert_neon_matches_reference(b"()", 9);
    assert_neon_matches_reference(b"()", usize::MAX);
    assert_neon_matches_reference(b"a()", 0);
    assert_neon_matches_reference(b"a()", 2);
    assert_neon_matches_reference(b"  ()", 1);
    assert_neon_matches_reference(&wrapped_pair(0, 100, 0), usize::MAX);
    assert_neon_matches_reference(&wrapped_pair(3, 100, 0), 2);
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_on_handwritten_inputs() {
    assert_every_index_matches_neon(b"");
    assert_every_index_matches_neon(b"(");
    assert_every_index_matches_neon(b"()");
    assert_every_index_matches_neon(b"((()))");
    assert_every_index_matches_neon(b"(()())");
    assert_every_index_matches_neon(b"a()b");
    assert_every_index_matches_neon(b"(((");
    assert_every_index_matches_neon(b"())))");
    assert_every_index_matches_neon(b"(xxxxxxxxxxxxxxxx)");
    assert_every_index_matches_neon(br#"("\)" ; )"#);

    let mut nested = vec![OPEN; 2 * BLOCK];
    nested.extend(std::iter::repeat_n(CLOSE, 2 * BLOCK));
    assert_every_index_matches_neon(&nested);
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_on_long_ordinary_runs() {
    for inner in [100usize, 257, 1000, 4096] {
        assert_neon_matches_reference(&wrapped_pair(0, inner, 0), 0);
        assert_neon_matches_reference(&wrapped_pair(0, inner, 37), 0);

        // Unmatched: the whole run is consumed and no close paren follows.
        let mut unmatched = vec![OPEN];
        unmatched.extend(std::iter::repeat_n(FILLER, inner));
        assert_neon_matches_reference(&unmatched, 0);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_around_the_vector_boundaries() {
    for boundary in [16usize, 32, 64] {
        let shortest = boundary - 2;
        let longest = boundary + 2;

        for length in shortest..=longest {
            assert_neon_matches_reference(&wrapped_pair(0, length, 0), 0);
            assert_neon_matches_reference(&wrapped_pair(0, length, 3), 0);
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_finds_a_match_landing_exactly_on_a_vector_boundary() {
    for boundary in [16usize, 32, 64] {
        // Close paren at index `boundary`, the first byte of the next block.
        let input = wrapped_pair(0, boundary - 1, 8);

        assert_eq!(super::neon::scan(&input, 0).index, Some(boundary));
        assert_neon_matches_reference(&input, 0);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_from_unaligned_start_indexes() {
    for prefix in 0..=17usize {
        for inner in [0usize, 1, 15, 16, 31, 33, 63, 65] {
            let input = wrapped_pair(prefix, inner, 5);

            assert_eq!(
                super::neon::scan(&input, prefix).index,
                Some(prefix + inner + 1)
            );
            assert_neon_matches_reference(&input, prefix);
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_in_the_scalar_tail_remainder() {
    for tail in 0..BLOCK {
        let inner = 4 * BLOCK + tail;

        assert_neon_matches_reference(&wrapped_pair(0, inner, 0), 0);

        // An unmatched remainder must report no match rather than reading past
        // the end of the input.
        let mut unmatched = vec![OPEN];
        unmatched.extend(std::iter::repeat_n(FILLER, inner));
        assert_neon_matches_reference(&unmatched, 0);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_reports_the_first_close_paren_that_reaches_depth_zero() {
    // Several close parens inside one block: the earliest one that drives the
    // depth to zero wins, so masks must be consumed in ascending byte order.
    let mut input = vec![OPEN];
    input.extend(std::iter::repeat_n(CLOSE, 3 * BLOCK));

    assert_eq!(super::neon::scan(&input, 0).index, Some(1));
    assert_neon_matches_reference(&input, 0);

    for lane in 0..BLOCK {
        let mut input = vec![OPEN];
        input.extend(std::iter::repeat_n(FILLER, lane));
        input.extend(std::iter::repeat_n(CLOSE, 2 * BLOCK));

        assert_eq!(super::neon::scan(&input, 0).index, Some(lane + 1));
        assert_neon_matches_reference(&input, 0);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_on_deep_nesting_across_many_blocks() {
    let depth = 300usize;
    let mut input = vec![OPEN; depth];
    input.extend(std::iter::repeat_n(CLOSE, depth));

    for level in 0..depth {
        assert_eq!(
            super::neon::scan(&input, level).index,
            Some(2 * depth - 1 - level)
        );
        assert_neon_matches_reference(&input, level);
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_matches_the_reference_on_generated_inputs() {
    let mut generator = Lcg::new(0x1234_5678_9ABC_DEF0);

    for _ in 0..200 {
        let length = generator.below(300) as usize;
        let open_weight = 5 + generator.below(40);
        let mut input = Vec::with_capacity(length);

        for _ in 0..length {
            let roll = generator.below(100);
            if roll < open_weight {
                input.push(OPEN);
            } else if roll < 2 * open_weight {
                input.push(CLOSE);
            } else {
                input.push(b'a' + (roll % 26) as u8);
            }
        }

        for open_index in 0..=input.len() {
            assert_neon_matches_reference(&input, open_index);
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn the_neon_kernel_agrees_with_the_scalar_kernel_on_generated_sparse_inputs() {
    let mut generator = Lcg::new(0x0BAD_C0DE_1234_5678);

    for _ in 0..100 {
        // Long stretches of ordinary bytes so most blocks carry no parenthesis.
        let length = 200 + generator.below(200) as usize;
        let mut input = Vec::with_capacity(length);

        for _ in 0..length {
            let roll = generator.below(100);
            if roll < 3 {
                input.push(OPEN);
            } else if roll < 6 {
                input.push(CLOSE);
            } else {
                input.push(b'a' + (roll % 26) as u8);
            }
        }

        for open_index in 0..=input.len() {
            let neon = super::neon::scan(&input, open_index);
            let scalar = scalar::scan(&input, open_index);

            assert_eq!(
                neon.index, scalar.index,
                "neon and scalar disagree at index {open_index}"
            );
            assert_neon_matches_reference(&input, open_index);
        }
    }
}
