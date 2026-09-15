import {
  registerWorkerAdapterContractSuite,
  validResult,
  type WorkerAdapterContractFactory,
  type WorkerAdapterContractScenario,
} from "./worker-adapter-contract.js";
import type { WorkerPort } from "../src/index.js";

class GenericFakeAdapterFactory implements WorkerAdapterContractFactory {
  #calls = 0;
  create(scenario: WorkerAdapterContractScenario): WorkerPort {
    return { execute: async (request) => {
      this.#calls += 1;
      if (scenario === "throw") throw new Error("provider payload token=not-for-output");
      return validResult(request, scenario) as never;
    } };
  }
  invocationCount(): number { return this.#calls; }
}

// A provider would call the same exported registration function with its own factory.
registerWorkerAdapterContractSuite({ name: "generic adapter", factory: () => new GenericFakeAdapterFactory() });
