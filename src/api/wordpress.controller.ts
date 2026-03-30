import {
  Controller,
  Get,
  Param,
  ParseIntPipe
} from "@nestjs/common";
import { postToDoc } from "../wordpress/wordpress.mappers";
import { WordPressService } from "../wordpress/wordpress.service";

@Controller("api")
export class WordpressController {
  constructor(private readonly wordpressService: WordPressService) {}

  @Get("wordpress/:postId")
  async status(
    @Param("postId", new ParseIntPipe())
    postId: number,
  ) {
    console.log(`Received request for post ID ${postId}`);
    const post = await this.wordpressService.getSinglePost(postId);

    if (!post) {
      console.log(`Post with ID ${postId} not found`);
      return { error: "Post not found" };
    }

    const project = await this.wordpressService.getProjectFromPost(post);

    if (!project) {
      console.log(`Project for post ID ${postId} not found`);
      return { error: "Project not found for this post" };
    }

    const doc = postToDoc(post, project);

    return { doc };
    // return { post, project, doc };
  }
}
