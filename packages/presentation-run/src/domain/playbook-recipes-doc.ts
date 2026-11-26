export function officialRecipesMarkdown(): string {
  return [
    "## Official recipes — academic/paper-white-courseware + education-training",
    "",
    "Page types (education-training): cover · route · concept · method · demo · transfer.",
    "Layouts (paper-white PART B, 16:9):",
    "- cover: giant pale-pink circle left + botanical motif + pale-green title band lower-left. Photo-led only if a real media src already exists.",
    "- route: coral short rule + chapter + a vertical path (spine + 4 stations). One short name + matching note per station. NOT stacked list pills, NOT leftover titles mashed onto a second note list.",
    "- method: coral short rule + chapter number + 3 vertical pale list panels with white circular wells. Copy is conditions (water / air / warmth), not seed parts.",
    "- concept: editorial argument — title 15% / unequal two-column 45:55 / labeled composition. Coral rule + footer.",
    "- demo: case-evidence — pale-pink top band + two-column body + dark-green result bar.",
    "- transfer: result bar + next-action panel + footer.",
    "Tokens: paper #FDFAF5, title #44712E, body #56687A, coral #F5987E, leaf #D7EBCE, blush #F9DED8.",
    "Chrome on body pages: coral rule ~72×6, chapter number upper-right, « » lower-left, ShortName｜Page lower-right.",
    "FORBIDDEN: homemade 4-step circles, soil/sun/seed doodles, cream+black text walls, YAML notes as titles.",
    "Images: read capability.md first. If imageSearch/imageGenerate are NO, use the no-image layouts above. Do not write src. If YES and the recipe is photo-led, decide the photo frame bounds, generate_image with that width and height, then write_page using the same bounds. Do not generate 16:9 and cover-crop into a different slot.",
  ].join("\n");
}
