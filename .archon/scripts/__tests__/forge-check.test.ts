import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  forgeOperation,
  gitCheckout,
  packScriptRunner,
  PR,
  type ScriptOptions,
} from './deliver-checks-harness';
import { REQUIRED_FORGE_OPERATIONS } from '../../workflows/sdlc/.shared/forge-check';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

const ANSWERED = forgeOperation('pr.view', null);
const ARCHON_HOME = join(tmpdir(), 'archon-home-elsewhere');
const SETUP = [
  'archon plugin add coleam00/Archon/plugins/forge-github',
  'GH_TOKEN',
  '~/.archon/.env',
  'ARCHON_HOME/.env',
  '/.archon/.env',
  'archon auth github',
];

function refusal(kind: string, message: string): string {
  return JSON.stringify({ operationId: 'op-labels', ok: false, error: { kind, message } });
}

function check(
  options: ScriptOptions & {
    mirror?: boolean;
    remoteUrl?: string;
    capabilities?: readonly string[];
    entry?: string;
  } = {}
) {
  const {
    mirror,
    remoteUrl,
    entry = 'deliver',
    capabilities = REQUIRED_FORGE_OPERATIONS,
    ...rest
  } = options;
  if (rest.forge?.kind === 'fake' && rest.forge.response) {
    const reads =
      typeof rest.forge.response === 'string' ? [rest.forge.response] : rest.forge.response;
    rest.forge = {
      ...rest.forge,
      response: reads.flatMap(read => [forgeOperation('metadata', { capabilities }), read]),
    };
  }
  const cwd = rest.cwd ?? gitCheckout({}, trackTempRoot);
  if (remoteUrl) {
    expect(spawnSync('git', ['remote', 'set-url', 'upstream', remoteUrl], { cwd }).status).toBe(0);
  }
  if (mirror === true) {
    spawnSync('git', ['remote', 'add', 'mirror', 'https://mirror.example.com/example/repo.git'], {
      cwd,
    });
  }
  return runPackScript(`${entry}/scripts/forge-check`, {
    cwd,
    ...rest,
    inputs: { ARCHON_HOME, ...rest.inputs },
  });
}

describe('forge-check refuses a run whose forge plugin cannot act', () => {
  it.each(['deliver', 'pr', 'ship', 'upkeep', 'forge-check'])('checks the forge plugin from %s', entry => {
    const run = check({ entry, forge: { kind: 'fake', response: ANSWERED } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.stdout).toContain('forge answered for ghe.example.com/example/repo');
    expect(run.forge).toEqual([
      expect.stringContaining('forge metadata'),
      expect.stringContaining('forge pr.view'),
    ]);
    expect(JSON.parse(run.forgeRequests[1] ?? '')).toEqual({
      selector: { kind: 'head', repo: PR.repo, headRepo: PR.repo, head: 'archon-forge-check' },
    });
  });

  it('accepts a capable installed plugin through host discovery and authenticated dispatch', () => {
    const plugin = `
      if (process.argv.includes('metadata')) {
        console.log(JSON.stringify({protocol: 1, name: 'github', version: 'test', forge: 'github',
          hosts: ['ghe.example.com'], capabilities: ${JSON.stringify(REQUIRED_FORGE_OPERATIONS)}, token_env: ['GH_TOKEN']}));
      } else {
        const request = await Bun.stdin.json();
        if (request.op !== 'pr.view' || process.env.ARCHON_FORGE_TOKEN !== 'accepted') throw new Error('invalid preflight read');
        console.log(JSON.stringify({operationId: request.operationId, ok: true, result: {op: 'pr.view', value: null}}));
      }
    `;
    const run = check({
      forge: {
        kind: 'home',
        config: {
          scanPath: false,
          plugins: [
            {
              plugin: 'github',
              command: process.execPath,
              args: ['--no-env-file', '-e', plugin],
            },
          ],
        },
      },
      inputs: { GH_TOKEN: 'accepted' },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.stdout).toContain('Read access is verified; write access is not');
    expect(run.stdout).toContain('source: GH_TOKEN');
  });

  it('refuses a plugin missing checks.state before the authenticated read', () => {
    const run = check({
      forge: { kind: 'fake', response: ANSWERED },
      capabilities: REQUIRED_FORGE_OPERATIONS.filter(op => op !== 'checks.state'),
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('missing: checks.state');
    expect(run.forge).toHaveLength(1);
    expect(run.forge[0]).toContain('forge metadata');
  });

  it('names both setup steps when no plugin claims the host', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('no_plugin_for_host', 'no forge plugin claims ghe.example.com'),
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no forge plugin claims ghe.example.com');
    for (const step of SETUP) expect(run.stderr).toContain(step);
  });

  it('names both setup steps when the credential is missing', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('no_credential', 'credential environment GH_TOKEN is not set'),
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('credential environment GH_TOKEN is not set');
    for (const step of SETUP) expect(run.stderr).toContain(step);
  });

  it('refuses when the host published no CLI command', () => {
    const run = check({ forge: { kind: 'no-host' } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ARCHON_CLI_COMMAND is not set');
  });

  it('names the update when the installed plugin lacks the read', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('unsupported_op', 'plugin github does not support pr.view'),
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('archon plugin update coleam00/Archon/plugins/forge-github');
    expect(run.stderr).toContain('may not support this operation either');
  });

  it('passes when a mirror on an unclaimed host sits beside a remote that answers', () => {
    const run = check({
      mirror: true,
      forge: {
        kind: 'fake',
        response: [
          ANSWERED,
          refusal('no_plugin_for_host', 'no forge plugin claims mirror.example.com'),
        ],
      },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(4);
    expect(run.stdout).toContain('forge answered for ghe.example.com/example/repo');
    expect(run.stdout).toContain('mirror.example.com/example/repo: forge pr.view failed');
  });

  it('probes distinct repositories on one host when only the second answers', () => {
    const cwd = gitCheckout({}, trackTempRoot);
    expect(
      spawnSync('git', ['remote', 'add', 'second', 'https://ghe.example.com/other/repo.git'], {
        cwd,
      }).status
    ).toBe(0);
    const run = check({
      cwd,
      forge: {
        kind: 'fake',
        response: [refusal('process_failed', 'first repository denied'), ANSWERED],
      },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(4);
    expect(
      [run.forgeRequests[1], run.forgeRequests[3]].map(
        request => JSON.parse(request ?? '').selector.repo
      )
    ).toEqual([
      PR.repo,
      { host: PR.repo.host, path: 'other/repo' },
    ]);
    expect(run.stdout).toContain('forge answered for ghe.example.com/other/repo');
    expect(run.stdout).toContain('ghe.example.com/example/repo: forge pr.view failed');
  });

});

describe('forge-check with the GitHub plugin release v0.11.1 shipped', () => {
  const released = {
    kind: 'home',
    config: {
      scanPath: false,
      plugins: [
        {
          plugin: 'github',
          command: process.execPath,
          args: ['--no-env-file', join(import.meta.dir, 'fixtures/released-github-plugin.ts')],
        },
      ],
    },
  } as const;
  const withToken = (GH_TOKEN: string) =>
    check({ forge: released, inputs: { GH_TOKEN, GITHUB_TOKEN: '' } });

  it('refuses the released plugin missing pack operations before its first mutation', () => {
    const run = withToken('accepted');
    expect(run.code).not.toBe(0);
    for (const operation of [
      'pr.draft',
      'checks.rerun',
      'repo.labels.list',
      'repo.label.ensure',
      'workitem.label.add',
      'workitem.edit-body',
      'pr.threads',
      'workitem.comment.upsert',
      'workitem.close',
      'workitem.create',
    ])
      expect(run.stderr).toContain(operation);
    expect(run.stderr).toContain('archon plugin update coleam00/Archon/plugins/forge-github');
  });
});
