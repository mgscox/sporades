import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the published Teams contract defines the public boundaries and is reachable from the reference index", async () => {
  const [teams, reference, config, clientTypes, serverTypes, clientApi, serverApi] = await Promise.all([
    readFile(new URL("../docs/reference/teams.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/guide/reference.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/.vitepress/config.mts", import.meta.url), "utf8"),
    readFile(new URL("../src/types/client.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/types/server.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/api/types/client.TeamsApi.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/api/types/server.CurrentUserTeamsApi.html", import.meta.url), "utf8"),
  ]);

  assert.match(reference, /Built-in Teams[\s\S]*reference\/teams\.md/);
  assert.match(config, /Built-in Teams[\s\S]*reference\/teams/);
  for (const heading of [
    "## Team model and compatibility",
    "## Manage Teams from a Capsule",
    "## Email-bound Join links",
    "## Authorize explicit Team resources",
    "## Security, storage, and audit boundaries",
  ]) assert.match(teams, new RegExp(heading));
  for (const statement of [
    /always available[\s\S]*never automatically partition/i,
    /no current Team/i,
    /only admins[\s\S]*memberships/i,
    /omit member emails/i,
    /returned[\s\S]*never sent/i,
    /non-consuming validation[\s\S]*authoritative join/i,
    /normalized email equality[\s\S]*does not require verified email/i,
    /Team admin[\s\S]*application roles[\s\S]*ACL[\s\S]*Privileged server role/i,
    /redacted security events/i,
  ]) assert.match(teams, statement);
  assert.match(clientTypes, /export type TeamsApi/);
  assert.match(clientTypes, /export const teams: TeamsApi/);
  assert.match(serverTypes, /export type CurrentUserTeamsApi/);
  assert.match(serverTypes, /export type AclTeamHelpers/);
  assert.match(clientApi, /TeamsApi/);
  assert.match(serverApi, /CurrentUserTeamsApi/);
});
