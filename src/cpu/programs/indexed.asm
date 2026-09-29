; Indexed addressing: LDA and STA with X, the address wrapping at 256,
; the framebuffer as plain RAM, reads and writes past RAM, and LDT
; reading a table out of the ROM, wrapping too.
;! log=0x11,0x22,0x33,0x44,0,0x80,0x01,0x40,0x77,0,9,0x5C
;! [0x40]=0xFF [0x7F]=0x81 [0x05]=0x77 [0x30]=0x11 [0x31]=0x22 [0x32]=0x33 [0x33]=0x44

        LDX #0x5C       ; ROM[0]'s low byte, read back at the end
        LDX #0
        LDA #0x11
        STA 0x30,X
        INX
        LDA #0x22
        STA 0x30,X
        INX
        LDA #0x33
        STA 0x30,X
        INX
        LDA #0x44
        STA 0x30,X
        LDX #0
read:   LDA 0x30,X
        OUT 3           ; 0x11, 0x22, 0x33, 0x44
        INX
        TXA
        CMP #4
        JNZ read

        ; Past RAM: 0x80 and up read 0 and ignore writes.
        LDA #0x55
        STA 0x80
        LDX #0x10
        STA 0x90,X
        LDA 0xA0
        OUT 3           ; 0

        ; The framebuffer's first and last bytes.
        LDA #0xFF
        STA 0x40
        LDA #0x81
        LDX #0x3F
        STA 0x40,X      ; 0x7F

        ; LDT: bit masks from a table, by X.
        LDX #7
        LDT masks,X
        OUT 3           ; 0x80
        LDX #0
        LDT masks,X
        OUT 3           ; 0x01
        LDX #6
        LDT masks,X
        OUT 3           ; 0x40

        ; The data address wraps: 0xF0 + 0x15 is 0x05.
        LDA #0x77
        LDX #0x15
        STA 0xF0,X
        LDA 0x05
        OUT 3           ; 0x77
        LDX #0x90
        LDA 0x80,X      ; 0x110 wraps to 0x10: never written, 0
        OUT 3           ; 0

        ; And so does the table address: last + 1 is ROM[0].
        LDX #0
        LDT last,X
        OUT 3           ; 9
        INX
        LDT last,X
        OUT 3           ; 0x5C, from the first instruction
        HLT

masks:  .byte 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80
        .org 0xFF
last:   .byte 9
