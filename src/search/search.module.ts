import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { CacheModule } from './cache.module';
import { DatabaseModule } from '../database/database.module';
import { IndexModule } from '../index/index.module';

@Module({
  imports: [DatabaseModule, IndexModule, CacheModule],
  providers: [SearchService],
  exports: [SearchService, CacheModule],
})
export class SearchModule {}
