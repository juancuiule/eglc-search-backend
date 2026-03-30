import { Module } from "@nestjs/common";
import { IndexModule } from "../index/index.module";
import { SearchModule } from "../search/search.module";
import { ApiKeyGuard } from "./guards/api-key.guard";
import { ReindexController } from "./reindex.controller";
import { SearchController } from "./search.controller";
import { WordpressController } from "./wordpress.controller";
import { WordPressModule } from "../wordpress/wordpress.module";

@Module({
  imports: [SearchModule, IndexModule, WordPressModule],
  controllers: [SearchController, ReindexController, WordpressController],
  providers: [ApiKeyGuard],
})
export class ApiModule {}
