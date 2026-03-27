import {
  Controller, Post, Put, Delete, Param, HttpCode, UseGuards,
  HttpStatus, ParseIntPipe,
} from '@nestjs/common';
import { IndexService } from '../index/index.service';
import { CacheService } from '../search/cache.service';
import { ApiKeyGuard } from './guards/api-key.guard';

@Controller('api/reindex')
@UseGuards(ApiKeyGuard)
export class ReindexController {
  constructor(
    private readonly indexService: IndexService,
    private readonly cache: CacheService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  startReindex() {
    this.indexService.startFullReindex();
    return { message: 'Reindex started' };
  }

  @Put(':id')
  async upsert(@Param('id', ParseIntPipe) id: number) {
    await this.indexService.upsertPost(id);
    this.cache.clear();
    return { message: 'Document reindexed' };
  }

  @Delete(':id')
  delete(@Param('id', ParseIntPipe) id: number) {
    this.indexService.deletePost(id);
    this.cache.clear();
    return { message: 'Document deleted' };
  }
}
