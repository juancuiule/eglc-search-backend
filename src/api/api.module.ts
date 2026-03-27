import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { ReindexController } from './reindex.controller';
import { SearchModule } from '../search/search.module';
import { IndexModule } from '../index/index.module';
import { ApiKeyGuard } from './guards/api-key.guard';

@Module({
  imports: [SearchModule, IndexModule],
  controllers: [SearchController, ReindexController],
  providers: [ApiKeyGuard],
})
export class ApiModule {}
