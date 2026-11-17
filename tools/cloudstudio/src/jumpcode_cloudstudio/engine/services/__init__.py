# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The AWS services the local cloud emulates, by the name the Studio and the agent use."""

from . import (apigatewayv2, dynamodb, events, lambda_, logs, s3, scheduler, secretsmanager, sns, sqs, ssm, stepfunctions,
               sts)

SERVICES = {module.NAME: module for module in (s3, dynamodb, sqs, sns, lambda_, apigatewayv2, stepfunctions, scheduler, events,
                                               secretsmanager, ssm, logs, sts)}
