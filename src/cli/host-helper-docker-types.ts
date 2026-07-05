import type { JsonObject } from "./host-helper-json.js";

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type DockerCommandResult = CommandResult;

export type DockerPsContainerRaw = JsonObject & {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: string;
};

export type DockerStatsRaw = JsonObject & {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
  BlockIO?: string;
  PIDs?: string;
};
