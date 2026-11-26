export function toolStepMeta(name: string): { tool: string; label: string } {
  switch (name) {
    case "think":
      return { tool: "think", label: "Think" };
    case "read_playbook":
    case "read_file":
      return { tool: "read_file", label: "Read" };
    case "research":
      return { tool: "research", label: "Research" };
    case "write_todo":
      return { tool: "write_todo", label: "Write Todo" };
    case "compose_deck":
      return { tool: "compose_deck", label: "Compose Deck" };
    case "generate_image":
      return { tool: "generate_image", label: "Image" };
    case "search_image":
      return { tool: "search_image", label: "Search Image" };
    case "write_page":
      return { tool: "write_page", label: "Write Page" };
    case "render_page":
      return { tool: "render_page", label: "Render" };
    case "review_pages":
      return { tool: "review_pages", label: "Review" };
    default:
      return { tool: name, label: name };
  }
}
