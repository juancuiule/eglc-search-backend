import { Controller, Get } from "@nestjs/common";
import { WordPressService } from "src/wordpress/wordpress.service";

@Controller("api")
export class WordpressController {
  constructor(private readonly wordpressService: WordPressService) {}

  @Get("wordpress")
  async status() {
    const post = await this.wordpressService.getSinglePost(34615);

    return post;
  }
}
