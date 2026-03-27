import { Module } from '@nestjs/common';
import { IndexService } from './index.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModule } from '../database/database.module';
import { WordPressModule } from '../wordpress/wordpress.module';

@Module({
  imports: [DatabaseModule, WordPressModule],
  providers: [IndexService, EmbeddingService],
  exports: [IndexService],
})
export class IndexModule {}
