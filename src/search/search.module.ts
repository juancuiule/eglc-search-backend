import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { CacheService } from './cache.service';
import { DatabaseModule } from '../database/database.module';
import { IndexModule } from '../index/index.module';

@Module({
  imports: [DatabaseModule, IndexModule],
  providers: [SearchService, CacheService],
  exports: [SearchService, CacheService],
})
export class SearchModule {}
