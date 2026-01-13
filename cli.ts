#!/usr/bin/env bun
import { main } from './src/cli/main'

main().then(code => process.exit(code))
