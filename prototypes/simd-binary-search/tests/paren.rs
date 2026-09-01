use simd_binary_search::find_matching_paren;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';
const FILLER: u8 = b'x';

/// Independent, obviously correct model of the contract, used to check the
/// public matcher on generated inputs.
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

fn assert_match(input: &[u8], open_index: usize, expected: Option<usize>) {
    let actual = find_matching_paren(input, open_index);
    assert_eq!(actual, expected, "index {open_index} in {input:?}");
}

fn assert_matches_naive(input: &[u8], open_index: usize) {
    let expected = naive_matching_paren(input, open_index);
    assert_match(input, open_index, expected);
}

/// `prefix` filler bytes, then a pair wrapping `inner` filler bytes, then
/// `suffix` filler bytes. The open parenthesis sits at index `prefix`.
fn wrapped_pair(prefix: usize, inner: usize, suffix: usize) -> Vec<u8> {
    let mut bytes = vec![FILLER; prefix];
    bytes.push(OPEN);
    bytes.extend(std::iter::repeat_n(FILLER, inner));
    bytes.push(CLOSE);
    bytes.extend(std::iter::repeat_n(FILLER, suffix));
    bytes
}

#[test]
fn empty_input_has_no_match() {
    assert_match(&[], 0, None);
    assert_match(&[], 7, None);
}

#[test]
fn an_index_past_the_end_has_no_match() {
    assert_match(b"()", 2, None);
    assert_match(b"()", 9, None);
    assert_match(b"()", usize::MAX, None);
}

#[test]
fn an_index_that_is_not_an_open_paren_has_no_match() {
    assert_match(b"a()", 0, None);
    assert_match(b"a()", 2, None);
    assert_match(b"  ()", 1, None);
}

#[test]
fn an_immediately_closed_pair_matches_the_next_byte() {
    assert_match(b"()", 0, Some(1));
}

#[test]
fn nested_pairs_match_their_own_depth() {
    assert_match(b"((()))", 0, Some(5));
    assert_match(b"((()))", 1, Some(4));
    assert_match(b"((()))", 2, Some(3));
}

#[test]
fn sibling_pairs_match_independently() {
    assert_match(b"(()())", 0, Some(5));
    assert_match(b"(()())", 1, Some(2));
    assert_match(b"(()())", 3, Some(4));
}

#[test]
fn unmatched_input_has_no_match() {
    assert_match(b"(", 0, None);
    assert_match(b"(((", 0, None);
    assert_match(b"(()", 0, None);
    assert_match(b"(xxxxxxxxxxxxxxxxxxxxxxxxxxxx", 0, None);
}

#[test]
fn a_surplus_close_paren_after_the_match_is_ignored() {
    assert_match(b"())))", 0, Some(1));
}

#[test]
fn quotes_escapes_and_comments_are_ordinary_data() {
    // The close parenthesis at index 3 sits inside quotes behind a backslash,
    // and it still closes the pair because no string, escape, or comment
    // parsing happens.
    let input = br#"("\)" ; )"#;

    assert_match(input, 0, Some(3));
    assert_matches_naive(input, 0);
}

#[test]
fn a_long_run_of_ordinary_bytes_before_the_match_is_skipped() {
    for inner in [100usize, 257, 1000, 4096] {
        let input = wrapped_pair(0, inner, 0);

        assert_match(&input, 0, Some(inner + 1));
    }
}

#[test]
fn lengths_at_and_around_the_vector_boundaries_match() {
    for boundary in [16usize, 32, 64] {
        let shortest = boundary - 2;
        let longest = boundary + 2;

        for length in shortest..=longest {
            let input = wrapped_pair(0, length, 0);

            assert_match(&input, 0, Some(length + 1));
        }
    }
}

#[test]
fn a_match_landing_exactly_on_a_vector_boundary_is_found() {
    for boundary in [16usize, 32, 64] {
        // Close paren at index `boundary`, the first byte of the next block.
        let input = wrapped_pair(0, boundary - 1, 8);

        assert_match(&input, 0, Some(boundary));
    }
}

#[test]
fn unaligned_start_indexes_match() {
    for prefix in 0..=17usize {
        for inner in [0usize, 1, 15, 16, 31, 33, 63, 65] {
            let input = wrapped_pair(prefix, inner, 5);

            assert_match(&input, prefix, Some(prefix + inner + 1));
        }
    }
}

#[test]
fn a_match_in_the_scalar_tail_remainder_is_found() {
    for tail in 1..=7usize {
        let inner = 64 + tail;
        let input = wrapped_pair(0, inner, 0);

        assert_match(&input, 0, Some(inner + 1));
    }
}

#[test]
fn an_unmatched_tail_remainder_reports_no_match() {
    for tail in 0..=7usize {
        let mut input = vec![OPEN];
        input.extend(std::iter::repeat_n(FILLER, 64 + tail));

        assert_match(&input, 0, None);
    }
}

#[test]
fn deep_nesting_across_many_blocks_matches_the_outermost_pair() {
    let depth = 300usize;
    let mut input = vec![OPEN; depth];
    input.extend(std::iter::repeat_n(CLOSE, depth));

    for level in 0..depth {
        assert_match(&input, level, Some(2 * depth - 1 - level));
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

fn generated_bytes(generator: &mut Lcg, length: usize, open_weight: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(length);

    for _ in 0..length {
        let roll = generator.below(100);
        if roll < open_weight {
            bytes.push(OPEN);
        } else if roll < 2 * open_weight {
            bytes.push(CLOSE);
        } else {
            bytes.push(b'a' + (roll % 26) as u8);
        }
    }

    bytes
}

fn generated_balanced_bytes(generator: &mut Lcg, length: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut depth = 0usize;

    while bytes.len() < length {
        let roll = generator.below(10);
        if roll < 4 {
            bytes.push(OPEN);
            depth += 1;
        } else if roll < 7 && depth > 0 {
            bytes.push(CLOSE);
            depth -= 1;
        } else {
            bytes.push(b'0' + (roll % 10) as u8);
        }
    }
    bytes.extend(std::iter::repeat_n(CLOSE, depth));

    bytes
}

#[test]
fn generated_varied_length_and_nesting_cases_match_the_naive_reference() {
    let mut generator = Lcg::new(0x5EED_1234_ABCD_0001);

    for _ in 0..400 {
        let length = generator.below(300) as usize;
        let open_weight = 5 + generator.below(40);
        let input = generated_bytes(&mut generator, length, open_weight);

        for open_index in 0..input.len() {
            assert_matches_naive(&input, open_index);
        }

        assert_match(&input, input.len(), None);
    }
}

#[test]
fn generated_balanced_cases_match_the_naive_reference() {
    let mut generator = Lcg::new(0x0BAD_C0DE_1234_5678);

    for _ in 0..200 {
        let input = generated_balanced_bytes(&mut generator, 260);

        for open_index in 0..input.len() {
            assert_matches_naive(&input, open_index);
        }
    }
}
