import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createMcpConsentSeam, createMcpContextFactory, renderConsentMessage, buildElicitationSchema } =
  await import('../../src/mcp/consent.js');

const sampleRequest = {
  affordance: 'start_generate',
  title: 'Start generate',
  actionClass: 'sample',
  summary: 'kick off content generation',
  disclosure: {
    cost: { kind: 'sample', model: 'copilot' },
    credentials: ['GITHUB_TOKEN'],
    writes: ['content/'],
  },
};

describe('mcp/consent — renderConsentMessage', () => {
  it('renders a deterministic, timestamp-free disclosure', () => {
    const a = renderConsentMessage(sampleRequest);
    const b = renderConsentMessage(sampleRequest);
    assert.equal(a, b);
    assert.match(a, /sample-class action/);
    assert.match(a, /Model cost: sample \(copilot\)/);
    assert.match(a, /GITHUB_TOKEN/);
    assert.match(a, /Writes: content\//);
    assert.match(a, /Approve this action\?/);
  });

  it('omits a "none" cost line', () => {
    const msg = renderConsentMessage({ affordance: 'x', actionClass: 'write', disclosure: { cost: { kind: 'none' } } });
    assert.doesNotMatch(msg, /Model cost/);
  });
});

describe('mcp/consent — buildElicitationSchema', () => {
  it('exposes disclosed credential names as optional string fields', () => {
    const schema = buildElicitationSchema(sampleRequest);
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.GITHUB_TOKEN.type, 'string');
  });
  it('is an empty object when nothing is disclosed', () => {
    assert.deepEqual(buildElicitationSchema({}), { type: 'object', properties: {} });
  });
});

describe('mcp/consent — createMcpConsentSeam', () => {
  it('throws without an elicitInput function', () => {
    assert.throws(() => createMcpConsentSeam({}), TypeError);
  });

  it('fails closed when the client does not advertise elicitation', async () => {
    let called = false;
    const seam = createMcpConsentSeam({
      elicitInput: async () => {
        called = true;
        return { action: 'accept' };
      },
      getClientCapabilities: () => ({}),
    });
    const decision = await seam(sampleRequest);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /does not support elicitation/);
    assert.equal(called, false, 'must not elicit when unsupported');
  });

  it('approves on action=accept and threads back non-empty credential values', async () => {
    const seam = createMcpConsentSeam({
      elicitInput: async () => ({ action: 'accept', content: { GITHUB_TOKEN: 'ghp_x', BLANK: '' } }),
      getClientCapabilities: () => ({ elicitation: {} }),
    });
    const decision = await seam(sampleRequest);
    assert.equal(decision.approved, true);
    assert.deepEqual(decision.credentials, { GITHUB_TOKEN: 'ghp_x' });
  });

  it('denies on action=decline', async () => {
    const seam = createMcpConsentSeam({
      elicitInput: async () => ({ action: 'decline' }),
      getClientCapabilities: () => ({ elicitation: {} }),
    });
    const decision = await seam(sampleRequest);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /decline/);
  });

  it('passes the rendered message + schema to elicitInput', async () => {
    let params;
    const seam = createMcpConsentSeam({
      elicitInput: async (p) => {
        params = p;
        return { action: 'accept' };
      },
      getClientCapabilities: () => ({ elicitation: {} }),
    });
    await seam(sampleRequest);
    assert.match(params.message, /Start generate/);
    assert.equal(params.requestedSchema.properties.GITHUB_TOKEN.type, 'string');
  });
});

describe('mcp/consent — createMcpContextFactory', () => {
  it('allow:true installs consentPolicy=allow and no requestConsent', () => {
    const ctx = createMcpContextFactory({ allow: true, cwd: '/tmp' })();
    assert.equal(ctx.seams.consentPolicy, 'allow');
    assert.equal(ctx.seams.requestConsent, undefined);
  });

  it('installs an elicitation-backed requestConsent seam when elicitInput is present', () => {
    const ctx = createMcpContextFactory({
      elicitInput: async () => ({ action: 'accept' }),
      getClientCapabilities: () => ({ elicitation: {} }),
    })();
    assert.equal(typeof ctx.seams.requestConsent, 'function');
    assert.equal(ctx.seams.consentPolicy, undefined);
  });

  it('installs no consent seam (fail-closed) when neither allow nor elicitInput given', () => {
    const ctx = createMcpContextFactory({})();
    assert.deepEqual(ctx.seams, {});
  });

  it('returns a fresh context each call', () => {
    const factory = createMcpContextFactory({ allow: true });
    assert.notEqual(factory(), factory());
  });
});
