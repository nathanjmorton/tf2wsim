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

data "archive_file" "fn" {
  type        = "zip"
  source_file = "${path.module}/src/index.js"
  output_path = "${path.module}/build/fn.zip"
}

resource "aws_s3_bucket" "orders" {
  bucket        = "orders-bucket"
  force_destroy = true
}

resource "aws_sqs_queue" "work" {
  name                       = "work-queue"
  visibility_timeout_seconds = 45
  message_retention_seconds  = 7200
}

resource "aws_lambda_function" "processor" {
  function_name = "order-processor"
  filename      = data.archive_file.fn.output_path
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  role          = "arn:aws:iam::000000000000:role/lambda"
  timeout       = 30
  environment {
    variables = { STAGE = "dev" }
  }
}

resource "aws_lambda_event_source_mapping" "work_to_processor" {
  event_source_arn = aws_sqs_queue.work.arn
  function_name    = aws_lambda_function.processor.arn
  batch_size       = 1
}
