# Parallel Wordpress Search Engine

This project is a parallel search engine for Wordpress, designed to efficiently search through large volumes of Wordpress content.

It indexes Wordpress posts, pages, and custom post types, allowing for fast and accurate search results. The search engine is built using a sqlite database that stores the indexed content. It indexes titles, authors, tags, content, excerpts, and categories of Wordpress posts.

It calculated embeddings for the indexed content using OpenAI's embedding API, which allows for semantic search capabilities. The search engine can handle multiple search queries in parallel, making it suitable for high-traffic Wordpress sites.

When a search query is made, the search engine retrieves the relevant indexed content from the sqlite database and calculates the similarity between the search query and the indexed content using cosine similarity. The search results are then ranked based on their relevance to the search query. A search query performs a fts5 full-text search on the indexed content, and the results are ranked based on their relevance to the search query and a cosine similarity score calculated using the embeddings.

The service exposes a REST API that allows clients to perform search queries and retrieve search results. The API is designed to be simple and easy to use, making it accessible to developers of all skill levels.

It also has an endpoint to reindex content that is used as a hook for a Wordpress plugin to trigger reindexing when content is updated or new content is added. This ensures that the search engine always has the most up-to-date content indexed for accurate search results.

It caches search results to improve performance for frequently searched queries, reducing the load on the database and improving response times for users with a ttl of 1 hour. The caching mechanism is designed to be efficient and scalable, allowing for fast retrieval of search results while minimizing the impact on system resources.

## Endpoints

- `POST /api/search`: This endpoint accepts a search query and returns the relevant search results based on the indexed content and the calculated embeddings. The search results are ranked based on their relevance to the search query and a cosine similarity score calculated using the embeddings.
- `POST /api/reindex`: This endpoint triggers the reindexing of content in the sqlite database. It is used as a hook for a Wordpress plugin to trigger reindexing when content is updated or new content is added. This ensures that the search engine always has the most up-to-date content indexed for accurate search results.
- `GET /api/status`: This endpoint returns the status of the search engine, including information about the number of indexed items and the last reindexing time. This allows clients to monitor the health and performance of the search engine.
- `PUT /api/reindex/:id`: This endpoint allows for reindexing of specific content based on its ID. It is used as a hook for a Wordpress plugin to trigger reindexing when specific content is updated or new content is added. This ensures that the search engine always has the most up-to-date content indexed for accurate search results.
- `DELETE /api/reindex/:id`: This endpoint allows for the deletion of specific indexed content based on its ID. It is used as a hook for a Wordpress plugin to trigger the deletion of indexed content when specific content is deleted from Wordpress. This ensures that the search engine always has accurate and up-to-date indexed content.

## Database Schema

## Tech Stack

It uses NestJS for the backend API, which provides a robust and scalable framework for building RESTful APIs. The sqlite database is used for storing indexed content, and OpenAI's embedding API is used for calculating embeddings for the indexed content. The caching mechanism is implemented using an in-memory cache, which allows for fast retrieval of search results while minimizing the impact on system resources.

It's deployed to a Digital Ocean droplet using Docker, which provides a simple and efficient way to deploy and manage the application. The use of Docker allows for easy scaling and deployment of the application, making it suitable for high-traffic Wordpress sites.

We use a docker compose file to manage the application and its dependencies, allowing for easy setup and deployment. The docker compose file defines the services required for the application, including the NestJS API and the sqlite database, and allows for easy configuration and management of these services.

We use traefik as a reverse proxy to route incoming requests to the appropriate services, providing a secure and efficient way to manage traffic to the application. Traefik allows for easy configuration of routing rules and provides features such as load balancing and SSL termination, making it an ideal choice for managing traffic to the application.

This service is exposed to the internet with the subdomain "search.elgatoylacaja.com"
