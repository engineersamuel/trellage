use std::process::Command;

#[cfg(target_arch = "aarch64")]
fn expected_backend() -> &'static str {
    "neon"
}

#[cfg(target_arch = "x86_64")]
fn expected_backend() -> &'static str {
    if std::arch::is_x86_feature_detected!("avx2") {
        "avx2"
    } else {
        "scalar"
    }
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
fn expected_backend() -> &'static str {
    "scalar"
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_simd-binary-search"))
        .args(args)
        .output()
        .expect("run command")
}

#[test]
fn search_prints_the_first_duplicate_index() {
    let output = run(&["search", "2", "1", "2", "2", "3"]);

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 stdout"),
        format!("backend={} result=found index=1\n", expected_backend())
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn verify_reports_success_for_the_detected_backend() {
    let output = run(&["verify"]);

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    assert!(stdout.starts_with(&format!("backend={} ", expected_backend())));
    assert!(stdout.ends_with(" status=ok\n"));
    assert!(output.stderr.is_empty());
}

#[test]
fn search_prints_a_missing_target_insertion_index() {
    let output = run(&["search", "3", "-5", "-1", "2", "2", "9"]);

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 stdout"),
        format!(
            "backend={} result=missing insertion_index=4\n",
            expected_backend()
        )
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_syntax_exits_two() {
    let output = run(&["search"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).expect("UTF-8 stderr"),
        "error: expected `search <target> [sorted-i32 ...]` or `verify`\n"
    );
}

#[test]
fn invalid_integer_exits_two() {
    let output = run(&["search", "nope"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).expect("UTF-8 stderr"),
        "error: `nope` is not an i32\n"
    );
}

#[test]
fn unsorted_input_exits_two() {
    let output = run(&["search", "4", "1", "9", "4"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).expect("UTF-8 stderr"),
        "error: input is not sorted at index 2: 9 > 4\n"
    );
}
