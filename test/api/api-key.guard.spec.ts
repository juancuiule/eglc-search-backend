import { ApiKeyGuard } from '../../src/api/guards/api-key.guard';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function makeContext(headerValue: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: headerValue ? { 'x-api-key': headerValue } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;

  beforeEach(() => {
    const config = { get: () => 'secret-key', getOrThrow: () => 'secret-key' } as unknown as ConfigService;
    guard = new ApiKeyGuard(config);
  });

  it('allows request with correct API key', () => {
    expect(guard.canActivate(makeContext('secret-key'))).toBe(true);
  });

  it('rejects request with wrong API key', () => {
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow();
  });

  it('rejects request with missing API key', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow();
  });
});
