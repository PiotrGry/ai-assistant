#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Efficient bootstrap for the reviewed 22 Pirx Agent Orchestrator EPICs.

API strategy:
- REST: labels, milestones, issue discovery, issue creation.
- GraphQL: Project V2 discovery, add item, one batched field update per issue.

The script is idempotent by exact issue title and never deletes anything.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

OWNER = "PiotrGry"
REPO_NAME = "ai-assistant"
REPO = f"{OWNER}/{REPO_NAME}"
PROJECT_NUMBER = 3
PROJECT_TITLE = "Pirx Agent Orchestrator"
API_VERSION = "2026-03-10"
REST_BASE = "https://api.github.com"
GRAPHQL_URL = "https://api.github.com/graphql"
DEFAULT_MUTATION_DELAY = 1.1
DEFAULT_MIN_REMAINING = 100

LABELS: dict[str, tuple[str, str]] = {
    "pirx-orchestrator": ("5319E7", "Pirx Agent Orchestrator work"),
    "needs-design": ("D4C5F9", "Requires design before implementation"),
    "needs-research": ("C2E0C6", "Requires research or experimentation"),
    "production-sensitive": ("B60205", "Touches production or sensitive delivery operations"),
}

MILESTONES: dict[str, tuple[str, str]] = {
    "M1": ("M1 — GitHub Task Layer", "GitHub Issues and Projects become the primary human-visible task interface for Pirx."),
    "M2": ("M2 — Orchestrator Core", "Task, Attempt, Checkpoint, Lease, Scheduler and safety foundations."),
    "M3": ("M3 — Code Worker Integration", "External code workers receive bounded coding attempts and finish after pushing code."),
    "M4": ("M4 — CI, Delivery & Continuous Execution", "Pirx monitors CI and delivery, handles worker availability and observes execution."),
    "M5": ("M5 — Autonomous Work Discovery", "Controlled discovery turns observations into candidate work without bypassing Pirx."),
    "M6": ("M6 — Codex Architecture Lab", "Hypothesis-driven architecture experiments, intelligence and retained knowledge."),
    "M7": ("M7 — Research & Intelligence", "External research retrieval, retained knowledge, monitoring and intelligence digests."),
}

def md(value: str) -> str:
    return textwrap.dedent(value).strip() + "\n"

@dataclass(frozen=True)
class Epic:
    number: int
    milestone: str
    title: str
    priority: str
    worker: str
    area: str
    risk: str
    labels: tuple[str, ...]
    body: str

EPICS: list[Epic] = [
    Epic(1, "M1", "[EPIC] GitHub Task Interface", "P1", "Pirx", "GitHub", "Low", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Make GitHub Issues the primary human-visible interface for work orchestrated by Pirx.

    A GitHub Issue should represent the Task from a human perspective and provide a readable timeline of important execution events.

    ## Responsibility boundary

    GitHub is the human-facing task interface. Pirx internal durable storage remains the machine source of truth.

    Pirx must not depend on parsing historical Issue comments to reconstruct its complete internal execution state.

    ## Core capabilities

    Pirx should eventually be able to:

    - read, search, create, update and close Issues
    - add human-readable lifecycle comments
    - associate Issues with internal Tasks
    - correlate Issues with Attempts, branches and commits

    ## Human-visible timeline

    Important events should include Task accepted, Attempt started, worker assigned, branch/worktree prepared, `CODE_PUSHED`, CI result, retry, cooldown, delivery, production verification, DONE and human-action-required events.

    Pirx should avoid posting noisy internal heartbeats.

    ## Expected relationship

        GitHub Issue
             |
             | human-visible task
             v
           Pirx
             |
             | machine state
             v
        durable storage

    ## Out of scope

    This EPIC does not implement Project custom fields, worker adapters, scheduler logic, CI monitoring, deployment monitoring or Pirx storage itself.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M1 — GitHub Task Layer

    ## Pirx architecture principle

    GitHub is for humans. Pirx durable storage is for machines.
    """)),

    Epic(2, "M1", "[EPIC] GitHub Project Integration", "P1", "Pirx", "GitHub", "Low", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Integrate Pirx with the GitHub Project used to organize orchestrated work.

    The Project should provide a clear planning and status view without becoming Pirx's internal execution database.

    ## Project metadata

    Pirx should understand and synchronize:

    - Status
    - Priority
    - Worker
    - Area
    - Risk
    - Work Type

    ## Responsibility boundary

    GitHub Project provides planning, filtering, grouping, human-readable status and backlog visibility.

    Pirx durable storage provides exact Task state, Attempt state, leases, checkpoints, cooldowns, execution history and detailed orchestration metadata.

    ## GitHub API resilience

    The implementation should centralize GitHub API behavior and include:

    - centralized GitHub API client
    - rate-limit tracking from response headers
    - primary and secondary rate-limit handling
    - serialized mutations
    - `Retry-After` support
    - bounded exponential backoff
    - webhook-first event handling where appropriate
    - reconciliation after missed events or restart
    - idempotent write operations
    - selective GraphQL queries that fetch only required fields

    ## Out of scope

    This EPIC does not require every internal state to become a Project field.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M1 — GitHub Task Layer

    ## Pirx architecture principle

    Project metadata is a human projection of orchestration state, not the orchestration state itself.
    """)),

    Epic(3, "M2", "[EPIC] Task & Attempt Model", "P1", "Pirx", "Orchestrator", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Define the durable execution model used by Pirx.

    The central distinction is between a long-lived Task and individual execution Attempts.

    ## Task

    A Task represents one logical line of work and should remain stable across retries, worker restarts and provider cooldowns.

    ## Attempt

    An Attempt represents one execution session performed by a worker. A single Task may have multiple Attempts.

        Task
          +-- Attempt 1 -> quota exhausted
          +-- Attempt 2 -> CODE_PUSHED -> CI failed
          +-- Attempt 3 -> CODE_PUSHED -> CI passed

    ## Important rule

    A retry does not create a new Task. It creates another Attempt for the same Task.

    ## Task data

    A Task may contain Task ID, GitHub Issue, goal, scope, acceptance criteria, priority, risk, required worker capability, lifecycle state and timestamps.

    ## Attempt data

    An Attempt may contain Attempt ID, Task ID, worker, provider, branch, worktree, timestamps, result, checkpoint, final commit SHA and blocking reason.

    ## Responsibility boundary

    Pirx owns Tasks and Attempts. External workers execute Attempts but do not own the lifecycle of the Task.

    ## Out of scope

    Worker adapters, CI monitoring, scheduler policy and GitHub synchronization.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M2 — Orchestrator Core

    ## Pirx architecture principle

    Tasks represent work. Attempts represent executions of that work.
    """)),

    Epic(4, "M2", "[EPIC] Checkpoint & Resume State", "P1", "Pirx", "Checkpoint", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Allow Pirx to safely interrupt and later continue an unfinished Task.

    A worker session must not be the only place where useful execution context exists.

    ## Checkpoint purpose

    A useful Checkpoint should include:

    - Task ID and previous Attempt ID
    - goal and current state
    - repository, branch, worktree and current commit
    - completed and remaining work
    - files changed
    - findings and hypotheses
    - tests and results
    - blocking reason
    - last relevant action
    - resume instruction

    ## Expected lifecycle

        Attempt -> interruption -> CHECKPOINT -> persistent storage -> new Attempt -> resume work

    ## Checkpoint triggers

    Provider quota exhaustion, worker interruption, machine restart, explicit pause, recoverable failure or another required Attempt.

    ## Responsibility boundary

    Pirx owns checkpoint persistence. The worker may provide useful state but does not own durable resume scheduling.

    ## Context efficiency

    A resumed worker should receive the smallest useful context necessary to continue the Task instead of full historical conversation.

    ## Out of scope

    Cooldown scheduling, worker selection, CI monitoring and GitHub synchronization.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M2 — Orchestrator Core

    ## Pirx architecture principle

    Worker sessions are temporary. Task state must survive them.
    """)),

    Epic(5, "M2", "[EPIC] Scheduler & Task Leasing", "P1", "Pirx", "Scheduler", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Create the scheduling and ownership mechanism that determines which Task may run and which worker currently owns it.

    ## Initial execution rule

        one active Task
        one active Attempt
        one worker
        one worktree

    Parallel execution can be added later.

    ## Task Lease

    A Task Lease prevents multiple workers from accidentally executing the same Task at the same time.

    A lease may contain Task ID, Attempt ID, worker, acquisition time, expiry/heartbeat state, worktree and branch.

    ## Scheduler responsibilities

    - find runnable Tasks
    - skip blocked Tasks
    - respect worker availability and cooldowns
    - acquire a Task Lease
    - create an Attempt
    - start the appropriate worker
    - prevent duplicate execution
    - release or transition leases safely

    ## Failure safety

    If ownership is uncertain, Pirx should prefer not to start another mutating worker until state is reconciled.

    ## Future parallelism

    The model should later permit independent Tasks, several providers and resource-aware scheduling.

    ## Out of scope

    Code-worker internals, CI monitoring, backlog discovery and advanced scheduling optimization.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M2 — Orchestrator Core

    ## Pirx architecture principle

    Before optimizing throughput, guarantee ownership.
    """)),

    Epic(6, "M2", "[EPIC] Worker Capability & Safety", "P1", "Pirx", "Security", "Prod-sensitive", ("pirx-orchestrator", "needs-design", "production-sensitive"), md("""
    ## Goal

    Define explicit capabilities and safety boundaries for every worker controlled by Pirx.

    Workers should receive only the permissions required to complete their assigned responsibility.

    ## Capability model

    Potential capabilities include repository read/write, local tests, commit, push assigned branch, CI/log/metric read access and production inspection.

    Sensitive capabilities should be explicitly granted. The absence of a capability should mean the action is not allowed.

    ## Code-worker boundary

    Code workers may normally inspect assigned code, modify code, run local tests, commit and push the assigned branch.

    Code workers must not automatically modify CI/CD, modify infrastructure, change infrastructure cost, perform uncontrolled production mutations, deploy unrelated code or select unrelated Tasks.

    ## Production access

    Production inspection should prefer read-only access. Mutations should require explicit capability, policy, Task scope and human approval where needed.

    ## Pirx responsibility

    Pirx should enforce capability boundaries before invoking workers or tools.

    ## Out of scope

    This EPIC establishes the capability model and safe defaults; it does not define every future permission in advance.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M2 — Orchestrator Core

    ## Pirx architecture principle

    Autonomy comes from explicit capabilities, not unrestricted access.
    """)),

    Epic(7, "M3", "[EPIC] Code Worker Interface", "P1", "Pirx", "Agent Adapter", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Define one provider-independent contract through which Pirx can execute coding Attempts using external workers.

    Claude Code, Codex and future workers should use the same core interface.

    ## Expected architecture

        Pirx
          v
        CodeWorkerInterface
          +-- ClaudeCodeAdapter
          +-- CodexAdapter
          +-- FutureAdapter

    ## Worker responsibility

        ATTEMPT_STARTED -> CODING -> LOCAL_TESTING -> COMMIT -> PUSH -> CODE_PUSHED -> RETURN

    `CODE_PUSHED` is the normal end of worker responsibility.

    ## Worker input

    Task ID, Attempt ID, Issue, goal, scope, acceptance criteria, repository, branch, worktree, capability/safety constraints, optional Checkpoint and optional CI failure evidence.

    ## Worker output

    Task ID, Attempt ID, result state, branch, final commit SHA, implementation summary, local tests/results, findings and caveats.

    ## Result states

    `CODE_PUSHED`, `BLOCKED`, `FAILED`, `QUOTA_EXHAUSTED`, `CANCELLED`, `UNKNOWN`.

    ## Important distinction

    `CODE_PUSHED` does not mean CI passed, deployment succeeded, production is healthy or Task is DONE. Responsibility returns to Pirx.

    ## Out of scope

    Provider-specific behavior belongs to individual worker integrations.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M3 — Code Worker Integration

    ## Pirx architecture principle

    Pirx is the control plane. External workers are bounded code executors.
    """)),

    Epic(8, "M3", "[EPIC] Claude Code Integration", "P1", "Claude", "Agent Adapter", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Connect Claude Code to Pirx as the primary application code worker through the common Code Worker Interface.

    ## Claude responsibilities

    Claude may inspect the assigned repository/worktree, understand Task scope, modify application code, add/update tests, run relevant local tests, debug code-level failures, use supplied CI failure evidence, commit and push the assigned branch.

    ## Claude must not own

    Task scheduling, Task Leases, cooldown scheduling, continuous CI monitoring, release/deployment monitoring, production completion tracking, CI/CD modification, infrastructure changes or infrastructure cost changes.

    ## Expected flow

        Pirx
          | Task + acceptance criteria + branch/worktree + optional checkpoint/evidence
          v
        ClaudeCodeAdapter
          v
        Claude Code
          | code -> tests -> commit -> push
          v
        CODE_PUSHED
          | branch + SHA
          v
        Pirx

    ## Adapter responsibilities

    CLI invocation, session startup, process state, output capture, quota detection, termination, completion detection and result normalization.

    ## Resume

    A new Attempt may receive previous Checkpoint, current branch/worktree, previous findings and CI failure evidence. Full historical conversation is not required.

    ## Out of scope

    Generic worker interface, CI monitoring, scheduler logic and deployment monitoring.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M3 — Code Worker Integration

    ## Pirx architecture principle

    Claude spends expensive model time on code understanding, implementation and debugging. Pirx handles orchestration.
    """)),
    Epic(9, "M3", "[EPIC] Worker Workspace Isolation", "P1", "Pirx", "Agent Adapter", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Provide every coding Task with a safely isolated Git workspace.

    Workers should not share mutable working directories.

    ## Initial model

        one Task
        one active Attempt
        one branch
        one worktree
        one active owner

    ## Pirx responsibilities

    Create the Task branch/worktree, associate it with the Task and Lease, provide it to the worker, preserve it while resumable work exists and clean it safely after completion.

    ## Worker responsibilities

    The worker may read/modify files, run tests, commit and push the assigned branch. It should not modify another Task's worktree, delete shared workspaces, switch to unrelated branches or mutate the primary checkout outside its assignment.

    ## Resume support

    Checkpoint state should preserve repository, branch, worktree path, current commit, Task ID and Attempt ID.

    ## Cleanup safety

    Before deleting a worktree Pirx should verify that no active Lease owns it, no resumable Attempt requires it, no unpushed work must be retained and relevant state is durable.

    ## Out of scope

    CI monitoring, architecture experiment cleanup and provider-specific worker logic.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M3 — Code Worker Integration

    ## Pirx architecture principle

    Workspace ownership should be deterministic before parallel execution is introduced.
    """)),

    Epic(10, "M3", "[EPIC] Codex Integration", "P2", "Codex", "Agent Adapter", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Connect Codex to Pirx through the same Code Worker Interface used by other coding agents.

    The first major use case will be Architecture Lab experiments.

    ## Responsibility boundary

    Codex is a code worker. It may inspect assigned code, implement experimental changes, run relevant local tests, commit and push the assigned branch.

    Codex does not own experiment scheduling, CI monitoring, deployment, production completion, architecture knowledge persistence or workspace garbage collection.

    ## Expected architecture

        Pirx -> CodeWorkerInterface -> CodexAdapter -> Codex

    ## Expected output

    Codex should return normalized Attempt result, branch, commit SHA, summary, tests, findings and caveats.

    ## Architecture Lab

    Architecture experiments may invoke Codex to produce code, while Pirx owns hypothesis state, baseline, measurements, experiment state, conclusions and retained knowledge.

    ## Out of scope

    This EPIC does not implement Architecture Lab itself.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M3 — Code Worker Integration

    ## Pirx architecture principle

    Provider integration is separate from the workflow that uses the provider.
    """)),

    Epic(11, "M4", "[EPIC] CI Feedback Loop", "P1", "Pirx", "Orchestrator", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Close the loop between pushed code, CI results and another coding Attempt when CI fails.

    Pirx should monitor CI while external workers remain inactive unless another code change is required.

    ## Expected lifecycle

        CODE_PUSHED -> CI_PENDING -> CI_RUNNING
                                  -> PASS
                                  -> FAIL -> collect failure evidence -> new Attempt -> code worker

    ## CI correlation

    Pirx must correlate results with the correct Task, Attempt, repository, branch, commit SHA and workflow run. An old successful workflow must not complete a newer commit.

    ## Failure evidence

    For failed CI, Pirx should collect bounded evidence such as workflow/run ID, failed job/step, error message, bounded log excerpt, commit SHA and CI URL.

    Pirx does not need sophisticated root-cause analysis in MVP.

    ## Retry model

    CI failure creates a new Attempt for the same Task. The worker receives original scope, current branch/worktree, previous Attempt summary, CI failure evidence and relevant Checkpoint.

    ## Important constraint

    The code worker cannot modify CI/CD unless a separate explicit capability permits it. If the problem appears to be CI/CD itself, Pirx should report it rather than silently changing the pipeline.

    ## Out of scope

    Deployment monitoring, production verification and advanced AI CI diagnosis.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M4 — CI, Delivery & Continuous Execution

    ## Pirx architecture principle

    Pirx observes failures and supplies evidence. Large models spend their reasoning budget fixing code.
    """)),

    Epic(12, "M4", "[EPIC] Delivery & Production Tracking", "P1", "Pirx", "Orchestrator", "Prod-sensitive", ("pirx-orchestrator", "needs-design", "production-sensitive"), md("""
    ## Goal

    Track a successfully tested change through release, deployment and production completion.

    A Task should not become DONE merely because a code worker pushed a branch.

    ## Expected lifecycle

        CODE_PUSHED -> CI_PASS -> RELEASE -> DEPLOY -> PROD_VERIFY -> DONE

    ## Important distinction

    `CODE_PUSHED`, `CI_PASS`, `DEPLOYED`, `PROD_VERIFIED` and `DONE` are different states. Worker completion is not Task completion.

    ## Pirx responsibilities

    Observe release status, deployment status, target environment, deployed version/commit, production completion condition and delivery failure.

    ## Correlation

    Pirx must verify that production state corresponds to the Task's expected commit. An unrelated successful deployment must not complete the Task.

    ## Production verification

    Prefer read-only signals such as deployment metadata, application version, health endpoint, release marker, monitoring state or explicit human confirmation.

    ## Safety

    Future rollback, redeploy or infrastructure repair must require separate capabilities and policies.

    ## Out of scope

    This EPIC does not allow unrestricted production mutation.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M4 — CI, Delivery & Continuous Execution

    ## Pirx architecture principle

    DONE means the required delivery outcome happened, not merely that coding stopped.
    """)),

    Epic(13, "M4", "[EPIC] Worker Availability & Automatic Resume", "P1", "Pirx", "Scheduler", "High", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Handle temporary worker unavailability such as provider quota exhaustion and automatically continue the same Task when the worker becomes available again.

    ## Expected lifecycle

        CODING -> QUOTA_EXHAUSTED -> CHECKPOINT -> COOLDOWN -> AVAILABLE -> NEW ATTEMPT -> CODING

    ## Important distinction

    Quota exhaustion is not a coding failure. It is a worker availability state.

    ## Detection

    Provider adapters should identify usage limits, cooldown requirement, reset time and temporary provider unavailability.

    ## Persisted cooldown state

    Provider, worker, reason, detection time, expected reset time, affected Task, previous Attempt and Checkpoint.

    ## Automatic resume

    When available, Pirx should verify the Task is valid, verify no active lease exists, create a new Attempt, load the Checkpoint and resume the same Task.

    ## Safety

    Pirx must not bypass provider restrictions. Unknown reset times should use bounded, non-aggressive checks.

    ## Human escalation

    Stop automatic resume if repeated Attempts fail, branch state is inconsistent, Task scope changed, required permissions are unavailable or human approval is required.

    ## Out of scope

    Provider billing changes and limit bypasses.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M4 — CI, Delivery & Continuous Execution

    ## Pirx architecture principle

    Cooldown interrupts an Attempt. It does not destroy the Task.
    """)),

    Epic(14, "M4", "[EPIC] Execution Observability", "P2", "Pirx", "Orchestrator", "Low", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Make orchestrated execution measurable and understandable.

    Pirx should be able to explain where time and Attempts were spent.

    ## Initial measurements

    - Task creation/start/completion time
    - Attempt count and duration
    - active coding time
    - CI waiting time
    - cooldown duration
    - delivery waiting time
    - retry count
    - worker/provider
    - failure count

    ## Expected questions

    How long did the Task take? How many Attempts were needed? How much time was actual coding, CI wait or provider cooldown? Which worker performed the work? Where was most wall-clock time spent?

    ## Storage

    Detailed measurements should live in Pirx durable storage. GitHub may receive concise summaries.

    ## Future extension

    Scheduling optimization, worker comparisons, provider usage analysis, latency analysis and p95 execution metrics.

    ## Out of scope

    Exact token billing, financial accounting, predictive scheduling and automatic model selection.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK

    ## Milestone

    M4 — CI, Delivery & Continuous Execution

    ## Pirx architecture principle

    Measure the workflow before trying to optimize it.
    """)),

    Epic(15, "M5", "[EPIC] Autonomous Discovery Pipeline", "P2", "Pirx", "Orchestrator", "High", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Create a controlled pipeline that turns autonomous observations into executable Tasks.

    Discovery should propose work rather than immediately execute arbitrary changes.

    ## Expected pipeline

        Observation -> Candidate -> Evaluation
                              -> REJECT
                              -> DUPLICATE
                              -> NEEDS_MORE_EVIDENCE
                              -> HUMAN_REVIEW
                              -> APPROVE -> Task

    ## Candidate model

    Title, description, source, evidence, affected area, expected impact, risk, confidence, suggested worker, proposed acceptance criteria and related Issues.

    ## Evaluation

    Pirx should consider duplication, evidence quality, scope, risk, required capability, production sensitivity, usefulness and acceptance criteria.

    ## Backlog replenishment

    If executable work becomes scarce, Pirx may trigger Candidate producers while maintaining bounded queues.

    ## Noise control

    Avoid uncontrolled recursive backlog generation and activity for its own sake.

    ## Responsibility boundary

    Candidate producers discover. Pirx evaluates. Approved Tasks enter the normal execution model.

    ## Out of scope

    Specific Scout internals and code-worker implementation.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / BUG

    ## Milestone

    M5 — Autonomous Work Discovery

    ## Pirx architecture principle

    Discovery and execution are separate security boundaries.
    """)),

    Epic(16, "M5", "[EPIC] Scout & Task Producers", "P2", "Scout", "Orchestrator", "Medium", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Define a common model for systems that can discover and propose Candidate Tasks.

    Scout is the first dedicated discovery worker, but it should not be the only possible producer.

    ## Potential producers

    Scout, Claude Code, monitoring, CI observations, Architecture Lab, Research & Intelligence and humans.

    ## Scout inputs

    Read-only evidence such as source code, Git history, Issues, CI failures, logs, metrics, test failures, performance signals and recurring incidents.

    ## Scout output

    Structured Candidate Tasks containing problem, evidence, affected area, expected impact, risk, confidence, proposed acceptance criteria and source references.

    ## Claude self-directed proposals

    Claude may identify bugs, refactoring opportunities, missing tests, technical debt and follow-up improvements. These become Candidates and must not bypass evaluation.

    ## Responsibility boundary

    Task producers propose. Pirx decides what becomes executable.

    ## Safety

    Discovery should normally be read-only. Scout must not mutate production, modify infrastructure/cost, modify CI/CD or automatically execute discovered Tasks.

    ## Out of scope

    Candidate evaluation itself.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M5 — Autonomous Work Discovery

    ## Pirx architecture principle

    Many systems may discover work. Only the orchestrator authorizes execution.
    """)),
    Epic(17, "M6", "[EPIC] Architecture Experiment Framework", "P2", "Pirx", "Architecture Lab", "Medium", ("pirx-orchestrator", "needs-design", "needs-research"), md("""
    ## Goal

    Create a structured workflow for reversible, evidence-driven architecture experiments.

    Architecture changes should be treated as hypotheses that can be tested.

    ## Experiment model

    Question, hypothesis, motivation, baseline, proposed change, experiment branch/worktree, measurements, result, conclusion and confidence.

    ## Expected lifecycle

        HYPOTHESIS -> BASELINE -> IMPLEMENT EXPERIMENT -> MEASURE -> COMPARE
                                                           -> supported
                                                           -> rejected
                                                           -> inconclusive
                                                           -> KNOWLEDGE

    ## Worker responsibility

    Codex or another code worker may implement experimental code, run relevant local tests, commit and push the experiment branch.

    Pirx owns experiment lifecycle, hypothesis state, measurement orchestration, result persistence and conclusions.

    ## Reversibility

    Experiments should use isolated branches/worktrees. Failed experiments should be disposable without losing what was learned.

    ## Production boundary

    Experiments must not automatically reach production. Promotion of a successful experiment becomes separate controlled work.

    ## Out of scope

    This EPIC does not define one universal architecture quality score.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / EXPERIMENT

    ## Milestone

    M6 — Codex Architecture Lab

    ## Pirx architecture principle

    Architecture improvement should be hypothesis → experiment → measurement → knowledge.
    """)),

    Epic(18, "M6", "[EPIC] Architecture Intelligence", "P2", "Pirx", "Architecture Lab", "Medium", ("pirx-orchestrator", "needs-research"), md("""
    ## Goal

    Generate useful architecture evidence from code, Git history and measurable system behavior.

    Architecture decisions should use several independent signals rather than intuition alone.

    ## Potential signals

    File churn, change coupling, files modified together, bug-fix hotspots, recurring regressions, dependency direction, module coupling, complexity, build/test duration, duplication, affected-test count, API surface and implementation effort.

    ## Git history

    Repository history can identify unstable boundaries, repeated fixes, high-change components and modules that frequently change together. These are signals, not automatic proof of bad architecture.

    ## Baselines

    Experiments should capture baseline measurements before evaluating changed code.

    ## Outputs

    Observations, experiment hypotheses, Candidate Tasks, experiment measurements and evidence attached to architecture decisions.

    ## Responsibility boundary

    Pirx performs or coordinates analysis. Large code workers should only be invoked when code reasoning or implementation is required.

    ## Out of scope

    No single synthetic architecture score.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M6 — Codex Architecture Lab

    ## Pirx architecture principle

    Use multiple independent signals to understand how architecture behaves over time.
    """)),

    Epic(19, "M6", "[EPIC] Architecture Knowledge", "P2", "Pirx", "Architecture Lab", "Medium", ("pirx-orchestrator", "needs-design", "needs-research"), md("""
    ## Goal

    Persist useful architecture knowledge independently from temporary worker sessions and experiment branches.

    What Pirx learned should survive after disposable experiment artifacts are removed.

    ## Knowledge record

    Question, hypothesis, context, baseline, experiment, measurements, result, conclusion, confidence, affected components, source commits, related Issues and timestamp.

    ## Knowledge states

    Hypothesis, observation, experiment result, validated conclusion, contradicted conclusion and outdated conclusion.

    ## Expected flow

        Hypothesis -> Experiment -> Evidence -> Conclusion -> Knowledge Base

    ## Garbage collection

    Temporary experiment worktrees, abandoned branches, intermediate files and obsolete generated artifacts may be removed after useful results are persisted and safety is verified.

    ## Responsibility boundary

    Pirx owns durable architecture knowledge. Code workers provide implementation and findings but are not the long-term memory system.

    ## Storage

    A vector database is not required initially. Structured durable storage may be enough.

    ## Out of scope

    This EPIC does not preserve every experiment branch forever.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M6 — Codex Architecture Lab

    ## Pirx architecture principle

    Preserve what was learned. Discard disposable experiment machinery when safe.
    """)),

    Epic(20, "M7", "[EPIC] Research Retrieval", "P3", "Pirx", "Research", "Medium", ("pirx-orchestrator", "needs-design", "needs-research"), md("""
    ## Goal

    Provide Pirx with a provider-independent way to search the web and retrieve useful external information.

    ## Expected architecture

        Pirx -> Research Retrieval
                  +-- Search Adapter
                  +-- Extraction Adapter
                  +-- Future Providers

    ## Search capabilities

    Web search, normalized results, source metadata, provider errors/rate limits and result retrieval.

    ## Extraction

    When ordinary search results are insufficient, Pirx may perform deeper extraction of technical documentation, long articles, structured tables, difficult pages, product pages and research papers.

    ## Provider strategy

    The architecture should not depend directly on one provider. Potential initial tools include Tavily for search/research and Firecrawl or equivalent for difficult extraction.

    ## Provenance

    Retrieved material should preserve URL, title, publisher/domain, retrieval time and extraction method.

    ## Efficiency

    Use the cheapest reliable retrieval mechanism first. Deep extraction only when simpler retrieval is insufficient.

    ## Out of scope

    Novelty detection, recurring research schedules, intelligence digests and arbitrary browser automation into private accounts.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M7 — Research & Intelligence

    ## Pirx architecture principle

    External research providers are replaceable adapters.
    """)),

    Epic(21, "M7", "[EPIC] Research Knowledge Pipeline", "P3", "Pirx", "Research", "Medium", ("pirx-orchestrator", "needs-design", "needs-research"), md("""
    ## Goal

    Turn raw research results into traceable, deduplicated and useful knowledge.

    Pirx should know not only what it found, but where it came from and whether it is actually new.

    ## Provenance

    Preserve source URL, title, publisher/domain, author/publication date when available, retrieval date, source type and supporting evidence.

    ## Source quality

    Allow contextual distinctions such as primary source, official documentation, academic publication, established reporting, secondary analysis, community discussion and unknown source.

    ## Novelty detection

    Potential classifications: `NEW`, `UPDATED`, `CONTRADICTED`, `DUPLICATE`, `LOW_VALUE`, `UNKNOWN`.

    ## Deterministic first

    Use normalized URLs, hashes, identifiers, timestamps, exact matches and metadata comparison before invoking an LLM for semantic comparison.

    ## Contradictions

    New evidence should not silently overwrite older contradictory information. Preserve old/new claims, sources, timestamps and contradiction state.

    ## Responsibility boundary

    Research workers discover information. Pirx owns retained research knowledge and provenance.

    ## Out of scope

    Perfect semantic deduplication is not required initially.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M7 — Research & Intelligence

    ## Pirx architecture principle

    Research is useful only when important claims remain traceable and changes can be detected.
    """)),

    Epic(22, "M7", "[EPIC] Research Monitoring & Digests", "P3", "Pirx", "Research", "Low", ("pirx-orchestrator", "needs-design"), md("""
    ## Goal

    Allow Pirx to monitor persistent research topics and periodically report meaningful changes.

    The output should focus on new and important information rather than repeatedly summarizing the same material.

    ## Research Topics

    Persistent Topics may contain name, description, scope, keywords, exclusions, source preferences, importance, schedule, last research time and known state.

    Example topics may include AI, local LLMs, DevOps, cloud, software architecture, science, technology and markets.

    ## Expected pipeline

        Research Topic -> scheduled research -> Retrieval -> Knowledge Pipeline -> Novelty Detection -> DIGEST

    ## Digest priorities

    What is genuinely new, what changed, contradictions, high-impact developments, relevant findings, unresolved questions and possible Candidate Tasks.

    ## Scheduling

    Cadence should be configurable: daily, weekly, manually requested or on meaningful change.

    ## Noise control

    If nothing meaningful changed, Pirx should report that succinctly rather than generating artificial content.

    ## Connection to orchestration

    Research findings may create Candidate Tasks, but they must pass through the Autonomous Discovery Pipeline before becoming executable.

    ## Out of scope

    Underlying search or extraction adapters.

    ## Role in hierarchy

    EPIC
    └── FEATURE
        └── TASK / RESEARCH

    ## Milestone

    M7 — Research & Intelligence

    ## Pirx architecture principle

    The valuable output is not more information. It is knowing what changed and why it matters.
    """)),
]

class ApiError(RuntimeError):
    pass

class RateLimitPause(RuntimeError):
    def __init__(self, message: str, *, resource: str | None = None, remaining: int | None = None, reset_at: int | None = None, retry_after: int | None = None):
        super().__init__(message)
        self.resource = resource
        self.remaining = remaining
        self.reset_at = reset_at
        self.retry_after = retry_after

def local_epoch(epoch: int | None) -> str:
    if epoch is None:
        return "unknown"
    return datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")

class GitHubClient:
    def __init__(self, token: str, *, mutation_delay: float, min_remaining: int):
        self.token = token
        self.mutation_delay = mutation_delay
        self.min_remaining = min_remaining
        self.last_mutation_at = 0.0
        self.known_limits: dict[str, dict[str, int]] = {}

    def headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "pirx-orchestrator-bootstrap-v3",
            "Content-Type": "application/json",
        }

    def throttle(self) -> None:
        if self.mutation_delay <= 0:
            self.last_mutation_at = time.monotonic()
            return
        now = time.monotonic()
        delay = self.mutation_delay - (now - self.last_mutation_at)
        if self.last_mutation_at > 0 and delay > 0:
            time.sleep(delay)
        self.last_mutation_at = time.monotonic()

    def update_rate_state(self, headers: Any) -> None:
        resource = headers.get("x-ratelimit-resource")
        remaining = headers.get("x-ratelimit-remaining")
        if not resource or remaining is None:
            return
        try:
            self.known_limits[resource] = {
                "remaining": int(remaining),
                "limit": int(headers.get("x-ratelimit-limit") or -1),
                "reset": int(headers.get("x-ratelimit-reset") or 0),
            }
        except ValueError:
            pass

    def check_budget(self, resource: str) -> None:
        state = self.known_limits.get(resource)
        if state and state["remaining"] < self.min_remaining:
            raise RateLimitPause(
                f"GitHub {resource} budget is below the safety floor.",
                resource=resource,
                remaining=state["remaining"],
                reset_at=state["reset"],
            )

    def request(self, method: str, url: str, *, payload: dict[str, Any] | None = None, mutating: bool = False, resource: str | None = None) -> tuple[Any, Any]:
        if mutating:
            if resource:
                self.check_budget(resource)
            self.throttle()

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(url, data=body, headers=self.headers(), method=method)

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read().decode("utf-8")
                self.update_rate_state(response.headers)
                return (json.loads(raw) if raw else None), response.headers
        except urllib.error.HTTPError as exc:
            self.update_rate_state(exc.headers)
            try:
                error_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                error_body = ""
            retry_raw = exc.headers.get("retry-after")
            remaining_raw = exc.headers.get("x-ratelimit-remaining")
            reset_raw = exc.headers.get("x-ratelimit-reset")
            retry_after = int(retry_raw) if retry_raw and retry_raw.isdigit() else None
            remaining = int(remaining_raw) if remaining_raw and remaining_raw.isdigit() else None
            reset_at = int(reset_raw) if reset_raw and reset_raw.isdigit() else None
            lowered = error_body.lower()
            if exc.code == 429 or remaining == 0 or "rate limit" in lowered or "secondary rate" in lowered:
                raise RateLimitPause(
                    f"GitHub API rate limited the request (HTTP {exc.code}).",
                    resource=exc.headers.get("x-ratelimit-resource"),
                    remaining=remaining,
                    reset_at=reset_at,
                    retry_after=retry_after,
                ) from None
            raise ApiError(f"GitHub API request failed: {method} {url}\nHTTP {exc.code}\n{error_body}") from None
        except urllib.error.URLError as exc:
            raise ApiError(f"Network error while calling GitHub: {exc}") from exc

    def rest(self, method: str, path: str, *, payload: dict[str, Any] | None = None, mutating: bool = False) -> Any:
        data, _ = self.request(method, REST_BASE + path, payload=payload, mutating=mutating, resource="core")
        return data

    def graphql(self, query: str, variables: dict[str, Any] | None = None, *, mutating: bool = False) -> dict[str, Any]:
        data, headers = self.request(
            "POST",
            GRAPHQL_URL,
            payload={"query": query, "variables": variables or {}},
            mutating=mutating,
            resource="graphql",
        )
        errors = data.get("errors") if isinstance(data, dict) else None
        if errors:
            messages = "\n".join(str(e.get("message", e)) for e in errors)
            if "rate limit" in messages.lower():
                rem = headers.get("x-ratelimit-remaining")
                reset = headers.get("x-ratelimit-reset")
                raise RateLimitPause(
                    messages,
                    resource="graphql",
                    remaining=int(rem) if rem and rem.isdigit() else None,
                    reset_at=int(reset) if reset and reset.isdigit() else None,
                )
            raise ApiError(f"GitHub GraphQL error:\n{messages}")
        if not isinstance(data, dict) or "data" not in data:
            raise ApiError(f"Unexpected GraphQL response: {data!r}")
        return data["data"]

    def rate_limits(self) -> dict[str, Any]:
        return self.rest("GET", "/rate_limit")

def get_token() -> str:
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        token = os.environ.get(name)
        if token:
            return token.strip()
    try:
        result = subprocess.run(["gh", "auth", "token"], text=True, capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise ApiError("No GH_TOKEN/GITHUB_TOKEN found and `gh auth token` failed. Run `gh auth login` first.") from exc
    token = result.stdout.strip()
    if not token:
        raise ApiError("`gh auth token` returned an empty token.")
    return token

def list_paginated(client: GitHubClient, path: str, *, per_page: int = 100) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        batch = client.rest("GET", f"{path}{sep}per_page={per_page}&page={page}")
        if not isinstance(batch, list):
            raise ApiError(f"Expected list response from {path}")
        out.extend(batch)
        if len(batch) < per_page:
            return out
        page += 1

def ensure_labels(client: GitHubClient, *, dry_run: bool) -> None:
    print("\n=== Labels ===")
    existing = {x["name"]: x for x in list_paginated(client, f"/repos/{REPO}/labels")}
    for name, (color, description) in LABELS.items():
        if name in existing:
            print(f"EXISTS   {name}")
        elif dry_run:
            print(f"WOULD CREATE {name}")
        else:
            print(f"CREATE   {name}")
            client.rest("POST", f"/repos/{REPO}/labels", payload={"name": name, "color": color, "description": description}, mutating=True)

def ensure_milestones(client: GitHubClient, *, dry_run: bool) -> dict[str, int | None]:
    print("\n=== Milestones ===")
    existing = {x["title"]: x for x in list_paginated(client, f"/repos/{REPO}/milestones?state=all")}
    out: dict[str, int | None] = {}
    for key, (title, description) in MILESTONES.items():
        item = existing.get(title)
        if item:
            out[key] = int(item["number"])
            print(f"EXISTS   {title} (#{item['number']})")
        elif dry_run:
            out[key] = None
            print(f"WOULD CREATE {title}")
        else:
            print(f"CREATE   {title}")
            created = client.rest("POST", f"/repos/{REPO}/milestones", payload={"title": title, "description": description, "state": "open"}, mutating=True)
            out[key] = int(created["number"])
    return out

def existing_issues(client: GitHubClient) -> dict[str, dict[str, Any]]:
    raw = list_paginated(client, f"/repos/{REPO}/issues?state=all")
    return {x["title"]: x for x in raw if "pull_request" not in x}

def create_issue(client: GitHubClient, epic: Epic, milestone_number: int) -> dict[str, Any]:
    return client.rest(
        "POST",
        f"/repos/{REPO}/issues",
        payload={"title": epic.title, "body": epic.body, "labels": list(epic.labels), "milestone": milestone_number},
        mutating=True,
    )

PROJECT_DISCOVERY_QUERY = r"""
query($number: Int!) {
  viewer {
    login
    projectV2(number: $number) {
      id
      number
      title
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
"""

@dataclass
class ProjectMetadata:
    project_id: str
    title: str
    owner_login: str
    fields: dict[str, dict[str, str]]

def discover_project(client: GitHubClient) -> ProjectMetadata:
    data = client.graphql(PROJECT_DISCOVERY_QUERY, {"number": PROJECT_NUMBER})
    viewer = data["viewer"]
    project = viewer.get("projectV2")
    if not project:
        raise ApiError(f"Project #{PROJECT_NUMBER} not found for viewer {viewer.get('login')!r}.")
    fields: dict[str, dict[str, str]] = {}
    for node in project["fields"]["nodes"]:
        if not node or node.get("__typename") != "ProjectV2SingleSelectField":
            continue
        options = {o["name"]: o["id"] for o in node.get("options", [])}
        options["__FIELD_ID__"] = node["id"]
        fields[node["name"]] = options
    return ProjectMetadata(project["id"], project["title"], viewer["login"], fields)

def field_values(epic: Epic) -> dict[str, str]:
    return {
        "Status": "Todo",
        "Priority": epic.priority,
        "Worker": epic.worker,
        "Area": epic.area,
        "Risk": epic.risk,
        "Work Type": "Epic",
    }

def validate_project_fields(meta: ProjectMetadata) -> None:
    required: dict[str, set[str]] = {
        "Status": {"Todo"},
        "Priority": {e.priority for e in EPICS},
        "Worker": {e.worker for e in EPICS},
        "Area": {e.area for e in EPICS},
        "Risk": {e.risk for e in EPICS},
        "Work Type": {"Epic"},
    }
    errors: list[str] = []
    for field, options in required.items():
        current = meta.fields.get(field)
        if not current:
            errors.append(f"Missing Project single-select field: {field}")
            continue
        missing = sorted(x for x in options if x not in current)
        if missing:
            errors.append(f"Field {field!r} missing option(s): {', '.join(missing)}")
    if errors:
        raise ApiError("Project field validation failed:\n- " + "\n- ".join(errors))

ADD_ITEM_MUTATION = r"""
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
    item { id }
  }
}
"""

def add_to_project(client: GitHubClient, meta: ProjectMetadata, issue_node_id: str) -> str:
    data = client.graphql(ADD_ITEM_MUTATION, {"project": meta.project_id, "content": issue_node_id}, mutating=True)
    return data["addProjectV2ItemById"]["item"]["id"]

def set_fields_batch(client: GitHubClient, meta: ProjectMetadata, item_id: str, epic: Epic) -> None:
    defs = ["$project: ID!", "$item: ID!"]
    variables: dict[str, Any] = {"project": meta.project_id, "item": item_id}
    mutations: list[str] = []
    for i, (field_name, option_name) in enumerate(field_values(epic).items()):
        field = meta.fields[field_name]
        fvar, ovar = f"field{i}", f"option{i}"
        defs.extend([f"${fvar}: ID!", f"${ovar}: String!"])
        variables[fvar] = field["__FIELD_ID__"]
        variables[ovar] = field[option_name]
        mutations.append(f"""
        set_{i}: updateProjectV2ItemFieldValue(input: {{
          projectId: $project
          itemId: $item
          fieldId: ${fvar}
          value: {{ singleSelectOptionId: ${ovar} }}
        }}) {{ projectV2Item {{ id }} }}
        """)
    query = "mutation(" + ", ".join(defs) + ") {\n" + "\n".join(mutations) + "\n}"
    client.graphql(query, variables, mutating=True)

def print_rate_limits(client: GitHubClient) -> None:
    payload = client.rate_limits()
    for name in ("core", "graphql"):
        state = payload.get("resources", {}).get(name)
        if state:
            print(f"{name:<7} {state['remaining']}/{state['limit']} remaining; reset {local_epoch(int(state['reset']))}")

def preflight(client: GitHubClient) -> ProjectMetadata:
    print("=== Preflight ===")
    repo = client.rest("GET", f"/repos/{REPO}")
    print(f"OK       repository {repo['full_name']}")
    meta = discover_project(client)
    print(f"OK       project #{PROJECT_NUMBER} {meta.title!r} owned by {meta.owner_login}")
    if meta.title != PROJECT_TITLE:
        print(f"WARN     expected title {PROJECT_TITLE!r}, got {meta.title!r}")
    validate_project_fields(meta)
    print("OK       required Project fields/options")
    print("\nRate limits:")
    print_rate_limits(client)
    return meta

def execute(client: GitHubClient, meta: ProjectMetadata, *, dry_run: bool) -> None:
    ensure_labels(client, dry_run=dry_run)
    milestones = ensure_milestones(client, dry_run=dry_run)
    issues = existing_issues(client)
    print(f"\nFound {sum(1 for e in EPICS if e.title in issues)} of {len(EPICS)} reviewed EPICs already present.")
    created = reused = 0
    print("\n=== EPIC creation ===")

    for idx, epic in enumerate(EPICS, 1):
        print(f"\n[{idx:02d}/{len(EPICS)}] {epic.title}")
        issue = issues.get(epic.title)
        if issue:
            reused += 1
            print(f"REUSE    #{issue['number']} {issue['html_url']}")
        elif dry_run:
            print(f"WOULD CREATE issue in {MILESTONES[epic.milestone][0]}")
            print("WOULD ADD Project item + ONE batched field mutation")
            continue
        else:
            milestone_number = milestones[epic.milestone]
            if milestone_number is None:
                raise ApiError(f"Missing milestone number for {epic.milestone}")
            issue = create_issue(client, epic, milestone_number)
            issues[epic.title] = issue
            created += 1
            print(f"CREATED  #{issue['number']} {issue['html_url']}")

        if dry_run:
            continue
        item_id = add_to_project(client, meta, issue["node_id"])
        print(f"PROJECT  {item_id}")
        set_fields_batch(client, meta, item_id, epic)
        print(f"FIELDS   Status=Todo Priority={epic.priority} Worker={epic.worker} Area={epic.area} Risk={epic.risk} Work Type=Epic")

    print("\n============================================================")
    print(" DRY RUN COMPLETE — no writes performed" if dry_run else " PIRX AGENT ORCHESTRATOR BOOTSTRAP COMPLETE")
    print("============================================================")
    print(f"Reviewed EPICs: {len(EPICS)}")
    print(f"Created:        {created}")
    print(f"Reused:         {reused}")
    if not dry_run:
        print("\nFinal rate limits:")
        print_rate_limits(client)

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Create the reviewed 22 Pirx Agent Orchestrator EPICs efficiently.")
    p.add_argument("--dry-run", action="store_true", help="Read/validate only; no GitHub writes.")
    p.add_argument("--yes", action="store_true", help="Skip confirmation.")
    p.add_argument("--mutation-delay", type=float, default=DEFAULT_MUTATION_DELAY, help=f"Seconds between mutating API requests (default {DEFAULT_MUTATION_DELAY}).")
    p.add_argument("--min-remaining", type=int, default=DEFAULT_MIN_REMAINING, help=f"Pause below this known primary budget (default {DEFAULT_MIN_REMAINING}).")
    p.add_argument("--rate-limit", action="store_true", help="Print REST/core and GraphQL limits and exit.")
    return p.parse_args()

def print_pause(exc: RateLimitPause) -> None:
    print("\n============================================================")
    print(" PAUSED — GitHub API rate limit")
    print("============================================================")
    print(str(exc))
    if exc.resource:
        print(f"Resource:    {exc.resource}")
    if exc.remaining is not None:
        print(f"Remaining:   {exc.remaining}")
    if exc.retry_after is not None:
        retry = datetime.now().astimezone() + timedelta(seconds=exc.retry_after)
        print(f"Retry-After: {exc.retry_after}s")
        print(f"Retry around: {retry.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    if exc.reset_at is not None:
        print(f"Reset:       {local_epoch(exc.reset_at)}")
    print("\nThe script is idempotent. Run the same command again after the limit clears.")

def main() -> int:
    args = parse_args()
    if args.mutation_delay < 0:
        print("--mutation-delay must be >= 0", file=sys.stderr)
        return 2
    if args.min_remaining < 1:
        print("--min-remaining must be >= 1", file=sys.stderr)
        return 2
    try:
        client = GitHubClient(get_token(), mutation_delay=args.mutation_delay, min_remaining=args.min_remaining)
        if args.rate_limit:
            print_rate_limits(client)
            return 0
        meta = preflight(client)
        print(f"\nEPIC count: {len(EPICS)}")
        print("Clean-run write plan: 22 REST issue creates + 22 Project add mutations + 22 batched field mutations.")
        print("All six Project fields are updated in ONE GraphQL request per EPIC.")
        print("The script does not delete anything.")
        if args.dry_run:
            print("\nDRY RUN — no GitHub writes will be performed.")
        elif not args.yes:
            if input("\nContinue with GitHub changes? [y/N] ").strip().lower() not in {"y", "yes"}:
                print("Cancelled.")
                return 0
        execute(client, meta, dry_run=args.dry_run)
        return 0
    except RateLimitPause as exc:
        print_pause(exc)
        return 75
    except ApiError as exc:
        print(f"\nERROR\n\n{exc}", file=sys.stderr)
        print("\nIf Project access is denied, try:\n    gh auth refresh -s project\n", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
