terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

# ---------- storage bucket (uploaded images land here) ----------
resource "aws_s3_bucket" "storage" {
  bucket        = "image-storage"
  force_destroy = true
}

# ---------- validator/uploader Lambda + Function URL ----------
data "archive_file" "upload" {
  type        = "zip"
  source_file = "${path.module}/src/upload.js"
  output_path = "${path.module}/build/upload.zip"
}

resource "aws_lambda_function" "upload" {
  function_name = "upload"
  filename      = data.archive_file.upload.output_path
  handler       = "upload.handler"
  runtime       = "nodejs20.x"
  role          = "arn:aws:iam::000000000000:role/lambda"
  timeout       = 30
  environment {
    variables = {
      # referencing the bucket grants the function bucket access in the simulator
      STORAGE_BUCKET = aws_s3_bucket.storage.bucket
    }
  }
}

# A Lambda Function URL is a direct HTTPS endpoint — no API Gateway needed.
resource "aws_lambda_function_url" "upload" {
  function_name      = aws_lambda_function.upload.function_name
  authorization_type = "NONE"
  cors {
    allow_origins = ["*"]
    allow_methods = ["*"]
  }
}

# ---------- website bucket (serves the upload form) ----------
resource "aws_s3_bucket" "site" {
  bucket        = "upload-site"
  force_destroy = true
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  index_document {
    suffix = "index.html"
  }
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  source       = "${path.module}/site/index.html"
  content_type = "text/html"
}
