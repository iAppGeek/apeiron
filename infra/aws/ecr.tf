resource "aws_ecr_repository" "service" {
  for_each = toset(var.services)

  name                 = "apeiron/${each.key}"
  image_tag_mutability = "MUTABLE" # `latest` moves with each release
  force_delete         = true      # a destroy removes the images too

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "keep_last_10" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
