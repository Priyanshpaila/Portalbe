import { promisify } from "util"
import { hash as _hash, compare } from "bcryptjs"

export const hashAsync = promisify(_hash)
export const compareAsync = promisify(compare)
