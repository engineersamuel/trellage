use std::process::ExitCode;

use simd_binary_search::{SearchOutcome, SortedI32, selected_backend, verify_accuracy};

const USAGE_ERROR: &str = "error: expected `search <target> [sorted-i32 ...]` or `verify`";

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", error.message);
            ExitCode::from(error.code)
        }
    }
}

fn run(args: Vec<String>) -> Result<(), CliError> {
    match args.as_slice() {
        [command] if command == "verify" => run_verify(),
        [command, target, values @ ..] if command == "search" => run_search(target, values),
        _ => Err(CliError::usage()),
    }
}

fn run_search(target: &str, values: &[String]) -> Result<(), CliError> {
    let target = parse_i32(target)?;
    let values = values
        .iter()
        .map(|value| parse_i32(value))
        .collect::<Result<Vec<_>, _>>()?;
    let sorted = SortedI32::new(&values).map_err(|error| CliError {
        code: 2,
        message: format!(
            "error: input is not sorted at index {}: {} > {}",
            error.index, error.previous, error.current
        ),
    })?;
    let backend = selected_backend();
    match sorted.find_first(target) {
        SearchOutcome::Found { first_index } => {
            println!("backend={backend} result=found index={first_index}");
        }
        SearchOutcome::Missing { insertion_index } => {
            println!("backend={backend} result=missing insertion_index={insertion_index}");
        }
    }
    Ok(())
}

fn run_verify() -> Result<(), CliError> {
    let summary = verify_accuracy().map_err(|error| CliError {
        code: 1,
        message: format!("error: verification mismatch: {error}"),
    })?;
    println!(
        "backend={} cases={} queries={} vector_queries={} status=ok",
        summary.backend, summary.cases, summary.queries, summary.vector_queries
    );
    Ok(())
}

fn parse_i32(value: &str) -> Result<i32, CliError> {
    value.parse().map_err(|_| CliError {
        code: 2,
        message: format!("error: `{value}` is not an i32"),
    })
}

struct CliError {
    code: u8,
    message: String,
}

impl CliError {
    fn usage() -> Self {
        Self {
            code: 2,
            message: USAGE_ERROR.to_owned(),
        }
    }
}
