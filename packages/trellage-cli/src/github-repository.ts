export const githubRepositoryError = (repository: string): string | undefined => {
  try {
    const url = new URL(repository)
    if (url.username.length > 0 || url.password.length > 0) {
      return "GitHub repository URL must not contain credentials"
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port.length > 0) {
      return "repository must be an HTTPS GitHub URL"
    }
    if (url.search.length > 0 || url.hash.length > 0 || !/^\/[^/]+\/[^/]+\.git$/.test(url.pathname)) {
      return "repository must be an HTTPS GitHub owner/repository.git URL"
    }
    return undefined
  } catch {
    return "repository must be an HTTPS GitHub URL"
  }
}
