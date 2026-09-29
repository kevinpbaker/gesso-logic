; Pong: you on the left, with the up and down buttons; the CPU on the
; right, getting back to the middle between shots and going for the
; ball once it's close. First to 11, then again.
;
; The screen is 32 × 16. Paddles are 4 pixels tall, in columns 1 and
; 30; the ball moves a pixel at a time, diagonally. Every pixel is
; drawn by `toggle`, which flips it: drawing and erasing are one call,
; so a paddle moving a row flips two pixels, not eight.
;
; A frame is a turn of the frame tick, `IN 1`, every 512 cycles. On even
; frames the paddles move, on odd ones the ball, a row a move each, so a
; paddle chasing the ball only just keeps up. The CPU's paddle heads for
; the middle while the ball goes away, and for the ball only once it
; comes within four columns: late enough that a ball aimed at a far
; corner can beat it. Against a player who never misses, it returns
; about 93 balls in 100.

BX    = 0x00            ; the ball
BY    = 0x01
DX    = 0x02            ; its direction: 1 or 0xFF (-1)
DY    = 0x03
PL    = 0x04            ; each paddle's top row; PR must follow PL
PR    = 0x05
SL    = 0x06            ; the scores, in BCD, so the hex displays
SR    = 0x07            ; that show them read 10 and 11, not 0A and 0B
TICK  = 0x08            ; the frame tick, as last seen
FRAME = 0x09            ; frames since the serve, a byte's worth
PX    = 0x0A            ; toggle's pixel
PY    = 0x0B
T     = 0x0C            ; scratch
W     = 0x0D            ; which paddle: 0 left, 1 right
DIR   = 0x0E            ; which way it goes: 1 up, 2 down, 0 neither

LEFT  = 1               ; the paddles' columns
RIGHT = 30
LOWEST = 12             ; a paddle's top row at the bottom: 16 − 4
REACH = 26              ; the column the CPU goes for the ball from
WIN   = 0x11            ; eleven, in BCD

; --- A game: scores to 0, a clear screen, paddles in the middle -----
start:  LDA #0
        STA SL
        STA SR
        OUT 0
        OUT 1
        LDX #64                 ; A is 0: 64 bytes of it
clear:  DEX
        STA 0x40,X
        JNZ clear
        LDA #6
        STA PL
        STA PR
        STA PY
paddles: LDA #LEFT              ; rows 6 to 9 of both columns
        STA PX
        CALL toggle
        LDA #RIGHT
        STA PX
        CALL toggle
        LDA PY
        ADD #1
        STA PY
        CMP #10
        JNZ paddles
        LDA #1
        STA DX
        STA DY
        IN 1
        STA TICK

; --- A serve: the ball from the middle, on a row the clock picks ----
serve:  LDA #16
        STA BX
        LDA FRAME
        AND #7
        ADD #4                  ; rows 4 to 11, away from the walls
        STA BY
        STA PY
        LDA BX
        STA PX
        CALL toggle

; --- The frame loop ---------------------------------------------------
wait:   IN 1                    ; wait for the tick to turn
        CMP TICK
        JZ wait
        STA TICK
        LDA FRAME
        ADD #1
        STA FRAME
        AND #1
        JNZ ball

; --- Even frames: each paddle, left then right, moves or not ---------
        LDA #0
        STA W
paddle: LDA W                   ; (loads leave the flags: CMP sets them)
        CMP #0
        JNZ ai
        IN 0                    ; left: the buttons, 1 up and 2 down
        JMP dir
ai:     LDA #7                  ; right: aim at the middle, or at the
        STA T                   ; ball once it's coming and close
        LDA DX
        CMP #1
        JNZ aim
        LDA BX
        CMP #REACH
        JNC aim
        LDA BY
        STA T
aim:    LDA PR
        ADD #1                  ; the paddle's upper middle row
        CMP T
        JNC below               ; above the aim: maybe down
        JZ still
        LDA #1
        JMP dir
below:  ADD #1                  ; its lower middle row
        CMP T
        JC still
        LDA #2
        JMP dir
still:  LDA #0
dir:    STA DIR
        LDX W
        AND #1
        JZ down
        LDA PL,X                ; up, unless at the top: the bottom
        CMP #0                  ; pixel off, the one above the top on
        JZ next
        ADD #3
        STA PY
        LDT columns,X
        STA PX
        CALL toggle
        LDX W
        LDA PL,X
        SUB #1
        STA PL,X
        STA PY
        CALL toggle
        JMP next
down:   LDA DIR                 ; down, unless at the bottom: the top
        AND #2                  ; pixel off, the one below on
        JZ next
        LDA PL,X
        CMP #LOWEST
        JZ next
        STA PY
        LDT columns,X
        STA PX
        CALL toggle
        LDX W
        LDA PL,X
        ADD #1
        STA PL,X
        ADD #3
        STA PY
        CALL toggle
next:   LDA W
        ADD #1
        STA W
        CMP #2
        JNZ paddle
        JMP wait

; --- Odd frames: the ball ---------------------------------------------
ball:   LDA BX                  ; off where it was
        STA PX
        LDA BY
        STA PY
        CALL toggle
        LDA BY                  ; down or up, bouncing off the walls
        ADD DY
        STA BY
        JZ flip
        CMP #15
        JNZ across
flip:   LDA #0
        SUB DY
        STA DY
across: LDA BX                  ; where it would go across
        ADD DX
        STA T
        CMP #LEFT               ; into a paddle's column: does the
        JNZ right               ; paddle cover its row?
        LDA BY
        SUB PL
        CMP #4
        JNC bounce
right:  LDA T
        CMP #RIGHT
        JNZ edges
        LDA BY
        SUB PR
        CMP #4
        JNC bounce
edges:  LDA T                   ; off an edge: a point
        CMP #0xFF
        JZ pointR
        CMP #32
        JZ pointL
        STA BX
        JMP draw
bounce: LDA #0                  ; back the other way
        SUB DX
        STA DX
        JMP draw
pointL: LDA SL
        CALL plus1
        STA SL
        OUT 0
        JMP scored
pointR: LDA SR
        CALL plus1
        STA SR
        OUT 1
scored: CMP #WIN
        JNZ serve
        LDX #64                 ; a win: the score stays up for 64 turns
over:   IN 1                    ; of the tick, 2 s at 15 kHz, then a new game
        CMP TICK
        JZ over
        STA TICK
        DEX
        JNZ over
        JMP start
draw:   LDA BX                  ; on where it is
        STA PX
        LDA BY
        STA PY
        CALL toggle
        JMP wait

; --- plus1: A + 1 in BCD: past 9, the low digit goes to 0 ---------------
plus1:  ADD #1
        STA T
        AND #0x0F
        CMP #10
        LDA T
        JNZ plussed
        ADD #6
plussed: RET

; --- toggle: flips the pixel at (PX, PY) ------------------------------
; Its byte is 0x40 + 4·PY + PX / 8, its bit PX mod 8. Clobbers A, B, X.
toggle: LDA PX
        AND #7
        TAX
        LDT masks,X
        TAB
        LDA PY
        SHL
        SHL
        STA T
        LDA PX
        SHR
        SHR
        SHR
        ADD T
        TAX
        LDA 0x40,X
        XOR B
        STA 0x40,X
        RET

masks:  .byte 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80
columns: .byte LEFT, RIGHT
