import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { WordPressModule } from './wordpress/wordpress.module';
import { IndexModule } from './index/index.module';
import { SearchModule } from './search/search.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DatabaseModule,
    WordPressModule,
    IndexModule,
    SearchModule,
    ApiModule,
  ],
})
export class AppModule {}
