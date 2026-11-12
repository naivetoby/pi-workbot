// @env node
export interface ProjectSpec {
  project: string
  branch?: string
}

export interface GitLabProject {
  id: number
  path_with_namespace: string
  default_branch: string
  web_url: string
}

export interface Issue {
  title: string
  description: string
  web_url: string
}

export interface MergeRequest {
  iid: number
  state: string
  source_branch: string
  target_branch: string
  web_url: string
}

export interface Pipeline {
  id: number
  web_url: string
  sha?: string
}
