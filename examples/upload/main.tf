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

# Storage bucket for uploaded images
resource "aws_s3_bucket" "storage" {
  bucket        = "image-storage"
  force_destroy = true
}

# Validator/uploader Lambda
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

# HTTP API that routes POST /upload to the Lambda
resource "aws_apigatewayv2_api" "api" {
  name          = "upload-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "upload" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.upload.arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "upload" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /upload"
  target    = "integrations/${aws_apigatewayv2_integration.upload.id}"
}
