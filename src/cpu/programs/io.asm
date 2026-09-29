; IN and OUT: the buttons and the frame tick read, the score displays
; written, and a port with nothing on it reading 0.
;< in0=0x0A in1=1
;! out0=0x03 out1=0x0B log=0x0A,1,0,0x0B
;! A=0x0B

        IN 0            ; the buttons
        OUT 3
        IN 1            ; the frame tick
        OUT 3
        IN 2            ; nothing there
        OUT 3
        LDA #3
        OUT 0           ; left score
        IN 0
        ADD #1
        OUT 1           ; right score: 0x0B
        OUT 3
        HLT
