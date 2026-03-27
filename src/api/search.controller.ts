import {
  Controller,
  Post,
  Get,
  Body,
  BadRequestException,
  HttpCode,
} from "@nestjs/common";
import { SearchService } from "../search/search.service";
import { IndexService } from "../index/index.service";

interface SearchBody {
  query?: string;
  limit?: number;
  page?: number;
}

@Controller("api")
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly indexService: IndexService,
  ) {}

  @Post("search")
  @HttpCode(200)
  async search(@Body() body: SearchBody) {
    const query = body?.query?.trim();
    if (!query) throw new BadRequestException("query is required");

    const limit = body.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException(
        "limit must be an integer between 1 and 50",
      );
    }

    const skip = body.page && body.page > 1 ? (body.page - 1) * limit : 0;

    return this.searchService.search(query, limit, skip);
  }

  @Get("status")
  status() {
    const s = this.indexService.getStatus();
    const result: Record<string, unknown> = {
      state: s.state,
      totalDocs: s.totalDocs,
      lastIndexedAt: s.lastIndexedAt,
    };
    if (s.state === "running" && s.progress) {
      result.progress = s.progress;
    }
    return result;
  }
}
