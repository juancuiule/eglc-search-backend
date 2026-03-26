import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WordPressService } from '../../src/wordpress/wordpress.service';

describe('WordPressService', () => {
  let service: WordPressService;

  beforeEach(async () => {
    process.env.WP_BASE_URL = 'https://mock.example.com';
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [WordPressService],
    }).compile();
    service = module.get(WordPressService);
  });

  it('getPosts returns empty array when WP returns non-array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'not found' }),
    }) as jest.Mock;

    const result = await service.getPosts('some-slug');
    expect(result).toEqual([]);
  });

  it('getSinglePost returns null when WP returns empty array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as jest.Mock;

    const result = await service.getSinglePost(99);
    expect(result).toBeNull();
  });

  it('getSinglePost returns the first post', async () => {
    const mockPost = { id_post: 99, title: 'Test' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [mockPost],
    }) as jest.Mock;

    const result = await service.getSinglePost(99);
    expect(result).toEqual(mockPost);
  });
});
