#!/usr/bin/env python3
"""Objective evaluation for the existing benchmark result files.

The runner deliberately keeps model answers untouched.  This evaluator adds a
small, deterministic oracle for cases whose expected answer can be checked
without a subjective LLM judge.  Open-ended writing and underspecified-dialogue
cases remain available for manual grading through grade.sh.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Callable, Iterable


ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"


def fold(value: str) -> str:
    """Lowercase and remove accents for stable Polish/English matching."""
    value = unicodedata.normalize("NFKD", value.lower())
    return "".join(char for char in value if not unicodedata.combining(char))


def has(text: str, *patterns: str) -> bool:
    return all(re.search(pattern, text, re.IGNORECASE | re.DOTALL) for pattern in patterns)


def any_has(text: str, *patterns: str) -> bool:
    return any(re.search(pattern, text, re.IGNORECASE | re.DOTALL) for pattern in patterns)


def grade(status: str, reason: str) -> dict[str, str]:
    return {"verdict": status, "reason": reason}


def simple_required(
    text: str,
    required: Iterable[str],
    forbidden: Iterable[str] = (),
    reason: str = "required answer elements",
) -> dict[str, str]:
    missing = [pattern for pattern in required if not re.search(pattern, text, re.IGNORECASE | re.DOTALL)]
    present_forbidden = [pattern for pattern in forbidden if re.search(pattern, text, re.IGNORECASE | re.DOTALL)]
    if not missing and not present_forbidden:
        return grade("pass", reason)
    if present_forbidden:
        return grade("fail", f"forbidden answer pattern: {present_forbidden[0]}")
    if missing and len(missing) < len(list(required)):
        return grade("partial", f"missing: {missing[0]}")
    return grade("fail", f"missing: {missing[0]}")


def d2(text: str) -> dict[str, str]:
    return simple_required(text, [r"9\s*[:.]\s*30", r"10\s*[:.]\s*00"], reason="correct overlap")


def d3(text: str) -> dict[str, str]:
    # A valid answer can name the whole window or a concrete 90-minute slot
    # inside it (09:00-10:30 or 10:00-11:30).
    if not has(text, r"11\s*[:.]\s*30") or not any_has(text, r"9\s*[:.]\s*00", r"10\s*[:.]\s*00"):
        return grade("fail", "did not identify a valid slot inside 09:00-11:30")
    if re.search(r"12\s*[:.]\s*30.{0,100}(60|godzin|hour)", text, re.IGNORECASE | re.DOTALL):
        return grade("partial", "correct window, but incorrect duration for 12:30-13:00")
    return grade("pass", "correct 90-minute window")


def d9(text: str) -> dict[str, str]:
    if not any_has(text, r"\bnie\b", r"brak", r"nie ma"):
        return grade("fail", "did not reject the 45-minute meeting")
    if not has(text, r"20\s*[- ]?(min|minute)", r"45\s*[- ]?(min|minute)"):
        return grade("partial", "rejection lacks both 20-minute and 45-minute facts")
    if re.search(r"(spotkan|rozmow).{0,80}13\s*[:.]\s*00", text, re.IGNORECASE | re.DOTALL) and not any_has(text, r"nie", r"brak"):
        return grade("fail", "appears to schedule the unavailable 13:00 slot")
    return grade("pass", "correctly rejects the insufficient window")


def d13(text: str) -> dict[str, str]:
    return simple_required(text, [r"11\s*[:.]\s*50", r"13\s*[:.]\s*00"], [r"9\s*[:.]\s*50.{0,30}(najpoz|latest|termin)"], "latest valid meeting")


def e1(text: str) -> dict[str, str]:
    if not has(text, r"nie.{0,50}(prac|nale[zż]y|dzial)" ):
        return grade("fail", "did not conclude that Ania is not in department X")
    if any_has(text, r"nie wiadomo", r"nie mozna stwierdzic", r"nie da sie rozstrzygnac"):
        return grade("fail", "introduced uncertainty where the implication is decisive")
    return grade("pass", "correct modus tollens conclusion")


def e2(text: str) -> dict[str, str]:
    if any_has(text, r"nie pada", r"nie musi padac"):
        return grade("pass", "correctly rejects the converse")
    if any_has(text, r"nie mozna stwierdzic", r"nie wiadomo"):
        return grade("partial", "recognizes that the converse is invalid but does not give the benchmark answer")
    return grade("fail", "incorrectly infers rain from the implication")


def e3(text: str) -> dict[str, str]:
    if has(text, r"zosia") and not any_has(text, r"kasia.{0,30}najml", r"basia.{0,30}najml"):
        return grade("pass", "correct age ordering")
    return grade("fail", "did not identify Zosia as youngest")


def e4(text: str) -> dict[str, str]:
    if any_has(text, r"nie wynika", r"nie mozna wnioskowac", r"nie musi", r"nie oznacza") and has(text, r"piotr"):
        return grade("pass", "correctly rejects affirming the consequent")
    return grade("fail", "incorrectly inferred that Piotr is a programmer")


def e5(text: str) -> dict[str, str]:
    if any_has(text, r"sprzecz", r"niemo[zż]liw", r"nie mo[zż]e byc prawd", r"toksycz"):
        return grade("pass", "recognized the contradiction")
    return grade("fail", "did not identify the contradictory premises")


def g1(text: str) -> dict[str, str]:
    has_60 = bool(re.search(r"60\s*%", text))
    has_25_as_answer = bool(re.search(r"^\s*25\s*%|25\s*%\s*respondentow\s+nie\s+prefer", text, re.IGNORECASE | re.MULTILINE))
    if has_60 and not has_25_as_answer:
        return grade("pass", "correct 60 percent answer")
    if has_60 and has_25_as_answer:
        return grade("partial", "contradictory 25 percent and 60 percent answers")
    return grade("fail", "did not answer 60 percent")


def g2(text: str) -> dict[str, str]:
    return simple_required(text, [r"(korelac|zwiazek|nie oznacza|nie wynika|przyczynow)"], reason="distinguishes correlation from causation")


def g3(text: str) -> dict[str, str]:
    if has(text, r"zespol\s*b", r"60") and not re.search(r"zespol\s*a.{0,40}(wiecej|24)", text, re.IGNORECASE | re.DOTALL):
        return grade("pass", "correct total comparison: B has 60")
    return grade("fail", "did not identify team B as larger total")


def g4(text: str) -> dict[str, str]:
    return simple_required(text, [r"nie mozna", r"(proba|3 osob|mala|reprezent|generaliz|calej firm)"], reason="rejects overgeneralization from n=3")


def g5(text: str) -> dict[str, str]:
    if has(text, r"(wtorek|czwartek)", r"(90|80)") and not any_has(text, r"poniedzialek", r"sroda", r"piatek"):
        return grade("pass", "correct below-average days")
    return grade("fail", "did not identify Tuesday and Thursday")


def h1(text: str) -> dict[str, str]:
    if not has(text, r"curl", r"echo", r"(kod|status|sukces|0)"):
        return grade("fail", "did not explain why echo masks curl failure")
    if any_has(text, r"return\s+1", r"exit\s+1", r"if\s*!\s*curl", r"curl\s+-f[^\n]*\n[^\n]*$" ):
        return grade("pass", "explains and propagates the curl failure")
    return grade("partial", "explains the problem but lacks a failure-propagating fix")


def h2(text: str) -> dict[str, str]:
    if has(text, r"(hasl|password|secret|credentials|poświadc|sekret)", r"(orders_app|config|secret|env|credential)") and not any_has(text, r"sie[cć]", r"network", r"dns"):
        return grade("pass", "prioritizes credential/secret validation")
    return grade("fail", "did not prioritize the authentication failure")


def h3(text: str) -> dict[str, str]:
    if has(text, r"(0\.0\.0\.0|\*|wsz|internet|public|source)" , r"22|ssh") and any_has(text, r"(cidr|ip|prefix|ogranicz|allowlist|lista dozwolonych)"):
        return grade("pass", "identifies public SSH exposure and restricts source")
    return grade("fail", "did not propose restricting SSH source access")


def h4(text: str) -> dict[str, str]:
    if has(text, r"forEach", r"(async|await)") and any_has(text, r"Promise\.all", r"for\s*.*of", r"await.*process"):
        return grade("pass", "waits for all asynchronous work")
    return grade("fail", "did not fix async forEach ordering")


def h5(text: str) -> dict[str, str]:
    if has(text, r"(ready|readiness)", r"8081") and has(text, r"8080"):
        return grade("pass", "identifies readiness probe port mismatch")
    return grade("fail", "did not identify the 8081 versus 8080 mismatch")


def i1(text: str) -> dict[str, str]:
    if has(text, r"no space|brak miejsca|pelny|dysk|filesystem", r"queue|kolej|db"):
        return grade("pass", "identifies disk exhaustion as the root cause")
    return grade("fail", "did not identify filesystem exhaustion")


def i2(text: str) -> dict[str, str]:
    if not has(text, r"zaden|żaden"):
        return grade("fail", "did not conclude that no vendor qualifies")
    required = [r"A", r"B", r"C", r"D"]
    missing = [item for item in required if not re.search(rf"\b{item}\b", text, re.IGNORECASE)]
    if missing:
        return grade("partial", f"did not evaluate vendor {missing[0]}")
    if not has(text, r"900|budzet|budżet", r"usa|region", r"tydzien|backup", r"rto|6"):
        return grade("partial", "does not identify all failing constraints")
    return grade("pass", "evaluates all vendors against all constraints")


def i3(text: str) -> dict[str, str]:
    if has(text, r"DB_POOL_MAX", r"500", r"polaczen|połączen|connection") and any_has(text, r"rollback|2\.8\.0|50"):
        return grade("pass", "connects the deployment change to the incident")
    return grade("fail", "did not identify DB_POOL_MAX=500 as root cause")


def i4(text: str) -> dict[str, str]:
    required = [r"REPLICAS", r"2", r"6", r"LOG_LEVEL", r"debug", r"info", r"FEATURE_X", r"true", r"false", r"HTTP_RETRIES", r"3", r"5"]
    return simple_required(text, required, reason="lists only configuration differences")


def i5(text: str) -> dict[str, str]:
    if has(text, r"(ustalone fakty|fakty)", r"(nadal nie wiadomo|nie wiadomo)") and has(text, r"11:17", r"11:29", r"502", r"4\.3\.0"):
        return grade("pass", "separates facts from unknowns")
    return grade("fail", "did not preserve the facts/unknowns distinction")


def d7(text: str) -> dict[str, str]:
    if has(text, r"7\s*[:.]\s*00", r"kalif|pacific|pdt"):
        return grade("pass", "correct July Poland-to-California conversion")
    return grade("fail", "incorrect July timezone conversion")


def d11(text: str) -> dict[str, str]:
    if has(text, r"8\s*[:.]\s*00", r"kalif|pacific|pst"):
        return grade("pass", "correct March Poland-to-California conversion")
    return grade("fail", "incorrect March timezone conversion")


def d12(text: str) -> dict[str, str]:
    if has(text, r"10\s*[:.]\s*00", r"30\s*min", r"90\s*min"):
        return grade("pass", "schedules the earliest call and remaining block")
    return grade("fail", "did not calculate the earliest call and remainder")


def d14(text: str) -> dict[str, str]:
    if has(text, r"raport", r"16\s*[:.]\s*00", r"45\s*min") and not re.search(r"(najpierw|zacznij).{0,30}(pulpit|telefon)", text, re.IGNORECASE | re.DOTALL):
        return grade("pass", "prioritizes the report with the imminent deadline")
    return grade("fail", "did not prioritize the report deadline")


def d15(text: str) -> dict[str, str]:
    if any_has(text, r"nie.*mie[sś]ci", r"225", r"3 godz") and has(text, r"50", r"70", r"40", r"65"):
        return grade("pass", "correctly detects that 225 minutes exceeds 180")
    return grade("fail", "did not identify the over-capacity schedule")


GRADERS: dict[str, Callable[[str], dict[str, str]]] = {
    "D2": d2, "D3": d3, "D9": d9, "D13": d13,
    "D7": d7, "D11": d11, "D12": d12, "D14": d14, "D15": d15,
    "E1": e1, "E2": e2, "E3": e3, "E4": e4, "E5": e5,
    "G1": g1, "G2": g2, "G3": g3, "G4": g4, "G5": g5,
    "H1": h1, "H2": h2, "H3": h3, "H4": h4, "H5": h5,
    "I1": i1, "I2": i2, "I3": i3, "I4": i4, "I5": i5,
}


def read_records(path: Path) -> list[dict]:
    records = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
    return records


def evaluate(record: dict) -> dict | None:
    case_id = record.get("id", "")
    grader = GRADERS.get(case_id)
    if grader is None:
        return None
    response = fold(record.get("response") or "")
    if record.get("error"):
        return grade("fail", f"runner error: {record['error']}")
    if not response:
        return grade("fail", "empty visible answer")
    if record.get("done_reason") == "length" and not response:
        return grade("fail", "generation ended at token limit without an answer")
    return grader(response)


def result_key(record: dict) -> tuple[str, str]:
    return (record.get("run_id") or "legacy", record.get("model") or "unknown")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path, help="result JSONL files; defaults to bench/results/*.jsonl")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()
    files = args.files or sorted(RESULTS.glob("*.jsonl"))
    if not files:
        print(f"No result files found in {RESULTS}", file=sys.stderr)
        return 1

    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for path in files:
        for record in read_records(path):
            groups[result_key(record)].append(record)

    summaries = []
    for (run_id, model), records in sorted(groups.items()):
        evaluated = []
        for record in records:
            verdict = evaluate(record)
            if verdict is not None:
                evaluated.append({**record, **verdict})
        if not evaluated:
            continue
        counts = Counter(item["verdict"] for item in evaluated)
        score = (2 * counts["pass"] + counts["partial"]) / (2 * len(evaluated)) * 100
        by_category: dict[str, Counter] = defaultdict(Counter)
        for item in evaluated:
            by_category[item.get("kategoria", "unknown")][item["verdict"]] += 1
        summaries.append({
            "run_id": run_id,
            "model": model,
            "evaluated": len(evaluated),
            "pass": counts["pass"],
            "partial": counts["partial"],
            "fail": counts["fail"],
            "score_percent": round(score, 1),
            "categories": {
                category: dict(sorted(counter.items()))
                for category, counter in sorted(by_category.items())
            },
            "failures": [
                {"id": item["id"], "repeat": item.get("repeat", 1), "reason": item["reason"]}
                for item in evaluated
                if item["verdict"] == "fail"
            ],
        })

    if args.json:
        print(json.dumps(summaries, ensure_ascii=False, indent=2))
        return 0

    print("=== Ocena obiektywna ===")
    for summary in summaries:
        print(f"-- run={summary['run_id']}  model={summary['model']}")
        print(
            "   oceniono={evaluated}  pass={pass}  partial={partial}  fail={fail}  wynik={score_percent:.1f}%".format(
                **summary
            )
        )
        for category, counts in summary["categories"].items():
            parts = " ".join(f"{key}={value}" for key, value in counts.items())
            print(f"   {category}: {parts}")
        for failure in summary["failures"][:8]:
            print(f"   FAIL [{failure['id']} r{failure['repeat']}]: {failure['reason']}")
    if not summaries:
        print("   brak przypadków z obiektywnym graderem")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
