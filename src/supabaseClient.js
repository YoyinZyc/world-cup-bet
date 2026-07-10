// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://rwenwposakkugyzitjjz.supabase.co'
const supabaseKey = 'sb_publishable_fwNKZ7POS0ZAmGLuQtrkew_Ap-sLUFJ'

export const supabase = createClient(supabaseUrl, supabaseKey)
