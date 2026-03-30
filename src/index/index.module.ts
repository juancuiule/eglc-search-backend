import { Module } from '@nestjs/common';
import { IndexService } from './index.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModule } from '../database/database.module';
import { WordPressModule } from '../wordpress/wordpress.module';
import { CacheModule } from '../search/cache.module';

@Module({
  imports: [DatabaseModule, WordPressModule, CacheModule],
  providers: [IndexService, EmbeddingService],
  exports: [IndexService, EmbeddingService],
})
export class IndexModule {}
