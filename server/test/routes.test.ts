import { describe, it, expect } from 'vitest';
import { buildApp, buildDeps } from '../src/app.js';
import { mockCfg } from './helpers.js';

async function setup() {
  const deps = await buildDeps({ cfg: mockCfg() });
  const app = buildApp(deps);
  const { token } = (await app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'c1' } })).json();
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  return { app, deps, call };
}

describe('REST（mock）', () => {
  it('未登录 401', async () => { const { app } = await setup(); expect((await app.inject({ method: 'POST', url: '/chat/message', payload: { text: 'hi' } })).statusCode).toBe(401); });
  it('问候不当场合，后续推进', async () => {
    const { call } = await setup();
    const r1 = (await call('POST', '/chat/message', { text: '你好' })).json();
    expect(r1.state).toBe('OCCASION'); expect(r1.slots).toEqual({}); expect(r1.intent).toBe('greeting');
    const r2 = (await call('POST', '/chat/message', { sessionId: r1.sessionId, text: '下周面试' })).json();
    expect(r2.state).toBe('STYLE');
  });
  it('一句话多槽位直达授权', async () => {
    const { call } = await setup();
    const r = (await call('POST', '/chat/message', { text: '约会穿搭，喜欢温柔风，会画妆，长发' })).json();
    expect(r.state).toBe('CONSENT'); expect(r.slots).toMatchObject({ occasion: '约会', style: ['温柔'], makeup_level: '会画', hair_length: '长发' });
  });
  it('他人会话 404', async () => {
    const a = await setup(); const { sessionId } = (await a.call('POST', '/chat/message', { text: '面试' })).json();
    const { token } = (await a.app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'other' } })).json();
    const r = await a.app.inject({ method: 'POST', url: '/chat/message', payload: { sessionId, text: 'x' }, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(404);
  });
  it('未授权不能拿人脸上传凭证', async () => {
    const { call } = await setup();
    const { sessionId } = (await call('POST', '/chat/message', { text: '面试' })).json();
    expect((await call('POST', '/photo/upload-ticket', { kind: 'face', sessionId })).statusCode).toBe(403);
    await call('POST', '/consent/face', { sessionId, agree: true });
    const t = (await call('POST', '/photo/upload-ticket', { kind: 'face', sessionId })).json();
    expect(t.key).toMatch(/^raw\//); expect(t.expireAt).toBeTruthy();
  });
  it('违禁文本被拦截', async () => { const { call } = await setup(); expect((await call('POST', '/chat/message', { text: '赌博' })).json().blocked).toBe(true); });
  it('look_spec + 渲染任务轮询（含 AI 标识）', async () => {
    const { call, deps } = await setup();
    const { sessionId } = (await call('POST', '/chat/message', { text: '约会' })).json();
    expect((await call('POST', '/look/generate', { sessionId })).json().lip.primary.hex).toMatch(/^#/);
    const t = (await call('POST', '/render/lip', { faceUrl: 'https://x/f.jpg', hex: '#D9735F' })).json();
    await deps.render.settle(t.taskId);
    expect((await call('GET', `/render/tasks/${t.taskId}`)).json().status).toBe('RUNNING');
    const done = (await call('GET', `/render/tasks/${t.taskId}`)).json();
    expect(done.status).toBe('SUCCEEDED'); expect(done.aiLabel).toMatchObject({ explicit: 'AI 生成', AIGC: 'true' });
  });
  it('参数错误 400', async () => { const { call } = await setup(); expect((await call('POST', '/render/lip', { faceUrl: 'https://x', hex: 'red' })).statusCode).toBe(400); });
});
