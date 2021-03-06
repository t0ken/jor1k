// -------------------------------------------------
// ------------------- VIRTIO ----------------------
// -------------------------------------------------
// Implementation of the virtio mmio device and virtio ring
//
// the following documentation were used
// http://wiki.osdev.org/Virtio
// http://lxr.free-electrons.com/source/Documentation/virtual/virtio-spec.txt?v=3.4
// http://swtch.com/plan9port/man/man9/
// http://lxr.free-electrons.com/source/net/9p/error.c?v=3.1
// https://lists.gnu.org/archive/html/qemu-devel/2011-12/msg02712.html
// http://www-numi.fnal.gov/offline_software/srt_public_context/WebDocs/Errors/unix_system_errors.html
// https://github.com/ozaki-r/arm-js/tree/master/js

"use strict";

var VIRTIO_MAGIC_REG = 0x0;
var VIRTIO_VERSION_REG = 0x4;
var VIRTIO_DEVICE_REG = 0x8;
var VIRTIO_VENDOR_REG = 0xc;
var VIRTIO_HOSTFEATURES_REG = 0x10;
var VIRTIO_HOSTFEATURESSEL_REG = 0x14;
var VIRTIO_GUESTFEATURES_REG = 0x20;
var VIRTIO_GUESTFEATURESSEL_REG = 0x24;
var VIRTIO_GUEST_PAGE_SIZE_REG = 0x28;
var VIRTIO_QUEUESEL_REG = 0x30;
var VIRTIO_QUEUENUMMAX_REG = 0x34;
var VIRTIO_QUEUENUM_REG = 0x38;
var VIRTIO_QUEUEALIGN_REG = 0x3C;
var VIRTIO_QUEUEPFN_REG = 0x40;
var VIRTIO_QUEUENOTIFY_REG = 0x50;
var VIRTIO_INTERRUPTSTATUS_REG = 0x60;
var VIRTIO_INTERRUPTACK_REG = 0x64;
var VIRTIO_STATUS_REG = 0x70;

var VRING_DESC_F_NEXT =      1; /* This marks a buffer as continuing via the next field. */
var VRING_DESC_F_WRITE =     2; /* This marks a buffer as write-only (otherwise read-only). */
var VRING_DESC_F_INDIRECT =  4; /* This means the buffer contains a list of buffer descriptors. */


// non aligned copy
function CopyMemoryToBuffer(from, to, offset, size) {
    for(var i=0; i<size; i++)
        to[i] = from.ReadMemory8(offset+i);
}

function CopyBufferToMemory(from, to, offset, size) {
    for(var i=0; i<size; i++)
        to.WriteMemory8(offset+i, from[i]);
}

function VirtIODev(intdev, ramdev, device) {
    this.dev = device;
    this.dev.SendReply = this.SendReply.bind(this);
    this.intdev = intdev;
    this.ramdev = ramdev;
    this.Reset();
}

VirtIODev.prototype.Reset = function() {
    this.status = 0x0;
    this.queuepfn = 0x0;
    this.intstatus = 0x0;
    this.pagesize = 0x0;
    this.queuenum = 0x100;
    this.align = 0x0;
    this.availidx = 0x0;

    this.descaddr = 0x0;
    this.usedaddr = 0x0;
    this.availaddr = 0x0;
    
    this.oldavailaddr = 0x0;
}

// Ring buffer addresses
VirtIODev.prototype.UpdateAddr = function() {
    this.descaddr = this.queuepfn * this.pagesize;
    this.availaddr = this.descaddr + this.queuenum*16;
    this.usedaddr = this.availaddr + 2 + 2 + this.queuenum*2 + 2;
    if (this.usedaddr & (this.align-1)) { // padding to next align boundary
        var mask = ~(this.align - 1);
        this.usedaddr = (this.usedaddr & mask) + this.align;
    }
}


VirtIODev.prototype.ReadReg8 = function (addr) {
    return this.dev.configspace[addr-0x100];
}


VirtIODev.prototype.ReadReg32 = function (addr) {
    var val = 0x0;
    switch(addr)
    {
        case VIRTIO_MAGIC_REG:
            val = 0x74726976; // "virt"
            break;

        case VIRTIO_VERSION_REG:
            val = 0x1;
            break;

        case VIRTIO_VENDOR_REG:
            val = 0xFFFFFFFF;
            break;

        case VIRTIO_DEVICE_REG:
            val = this.dev.deviceid;
            break;

        case VIRTIO_HOSTFEATURES_REG:
            val = this.dev.hostfeature;
            break;

        case VIRTIO_QUEUENUMMAX_REG:
            val = 0x100;
            break;

        case VIRTIO_QUEUEPFN_REG:
            val = this.queuepfn;
            break;

        case VIRTIO_STATUS_REG:
            val = this.status;
            break;

        case VIRTIO_INTERRUPTSTATUS_REG:
            val = this.intstatus;
            break;

        default:
            DebugMessage("Error in VirtIODev: Attempt to read register " + hex8(addr));
            abort();
            break;
    }
    return Swap32(val);
};

VirtIODev.prototype.GetDescriptor = function(index) {

    var addr = this.queuepfn * this.pagesize + index * 16;
    var buffer = new Uint8Array(16);
    CopyMemoryToBuffer(this.ramdev, buffer, addr, 16);

    var desc = StructToArray(["w", "w", "w", "h", "h"], buffer, 0);
//    DebugMessage("GetDescriptor: index=" + index + " addr=" + hex8(Swap32(desc[1])) + " len=" + Swap32(desc[2]) + " flags=" + Swap16(desc[3])  + " next=" + Swap16(desc[4]));

    return {
        addrhigh: Swap32(desc[0]),
        addr: Swap32(desc[1]),
        len: Swap32(desc[2]),
        flags: Swap16(desc[3]),
        next: Swap16(desc[4])        
    };
}

// the memory layout can be found here: include/uapi/linux/virtio_ring.h

VirtIODev.prototype.PrintRing = function() {
    this.desc = this.GetDescriptor(0);
    for(var i=0; i<10; i++) {
        DebugMessage("next: " + this.desc.next + " flags:" + this.desc.flags + " addr:" + hex8(this.desc.addr));
        if (this.desc.flags & 1)
        this.desc = this.GetDescriptor(this.desc.next); else
        break;
    }
    var availidx = this.ramdev.ReadMemory16(this.availaddr + 2) & (this.queuenum-1);
    DebugMessage("avail idx: " + availidx);
    DebugMessage("avail buffer index: " + this.ramdev.ReadMemory16(this.availaddr + 4 + (availidx-4)*2));
    DebugMessage("avail buffer index: " + this.ramdev.ReadMemory16(this.availaddr + 4 + (availidx-3)*2));
    DebugMessage("avail buffer index: " + this.ramdev.ReadMemory16(this.availaddr + 4 + (availidx-2)*2));
    DebugMessage("avail buffer index: " + this.ramdev.ReadMemory16(this.availaddr + 4 + (availidx-1)*2));
    //DebugMessage("avail ring: " + this.ramdev.ReadMemory16(availaddr+4 + availidx*2 + -4) );
    //DebugMessage("avail ring: " + this.ramdev.ReadMemory16(availaddr+4 + availidx*2 + -2) );
    //DebugMessage("avail ring: " + this.ramdev.ReadMemory16(availaddr+4 + availidx*2 + 0) );
    var usedidx = this.ramdev.ReadMemory16(this.usedaddr + 2) & (this.queuenum-1);
    DebugMessage("used idx: " + usedidx);
}


VirtIODev.prototype.ConsumeDescriptor = function(descindex, desclen) {
    var index = this.ramdev.ReadMemory16(this.usedaddr + 2); // get used index
    //DebugMessage("used index:" + index + " descindex=" + descindex);
    var usedaddr = this.usedaddr + 4 + (index & (this.queuenum-1)) * 8;
    this.ramdev.WriteMemory32(usedaddr+0, descindex);
    this.ramdev.WriteMemory32(usedaddr+4, desclen);
    this.ramdev.WriteMemory16(this.usedaddr + 2, (index+1));
}

VirtIODev.prototype.SendReply = function (index) {
    //DebugMessage("Send Reply");
    this.ConsumeDescriptor(index, this.dev.replybuffersize);

    var desc = this.GetDescriptor(index);
    while ((desc.flags & VRING_DESC_F_WRITE) == 0) {
        desc = this.GetDescriptor(desc.next);
    }
    
    if ((desc.flags & VRING_DESC_F_WRITE) == 0) {
        DebugMessage("Error in virtiodev: Descriptor is not allowed to write");
        abort();
    }

    var offset = 0;
    for(var i=0; i<this.dev.replybuffersize; i++) {
        if (offset >= desc.len) {
            desc = this.GetDescriptor(desc.next);
            offset = 0;            
            if ((desc.flags & VRING_DESC_F_WRITE) == 0) {
                DebugMessage("Error in virtiodev: Descriptor is not allowed to write");
                abort();
            }
        }
        this.ramdev.WriteMemory8(desc.addr+offset, this.dev.replybuffer[i]);
        offset++;
    }

    this.intstatus = 1;
    this.intdev.RaiseInterrupt(0x6);
}



VirtIODev.prototype.WriteReg32 = function (addr, val) {
    val = Swap32(val);
    switch(addr)
    {
        case VIRTIO_GUEST_PAGE_SIZE_REG:
            this.pagesize = val;
            this.UpdateAddr();
            //DebugMessage("Guest page size : " + hex8(val));
            break;

        case VIRTIO_STATUS_REG:
            //DebugMessage("write status reg : " + hex8(val));
            this.status = val;
            break;

        case VIRTIO_HOSTFEATURESSEL_REG:
            //DebugMessage("write hostfeaturesel reg : " + hex8(val));
            break;

        case VIRTIO_GUESTFEATURESSEL_REG:
            //DebugMessage("write guestfeaturesel reg : " + hex8(val));
            break;

        case VIRTIO_GUESTFEATURES_REG:
            //DebugMessage("write guestfeatures reg : " + hex8(val));
            break;

        case VIRTIO_QUEUESEL_REG:
            //DebugMessage("write queuesel reg : " + hex8(val));
            break;

        case VIRTIO_QUEUENUM_REG:
            this.queuenum = val;
            this.UpdateAddr();
            //DebugMessage("write queuenum reg : " + hex8(val));
            break;

        case VIRTIO_QUEUEALIGN_REG:
            //DebugMessage("write queuealign reg : " + hex8(val));
            this.align = val;
            this.UpdateAddr();
            break;

        case VIRTIO_QUEUEPFN_REG:
            this.queuepfn = val;
            this.UpdateAddr();
            //DebugMessage("write queuepfn reg : " + hex8(val));
            break;

        case VIRTIO_QUEUENOTIFY_REG:
            //DebugMessage("write queuenotify reg : " + hex8(val));
            this.UpdateAddr();
            if (val != 0) {
                DebugMessage("Error in virtiodev: Untested case of queuenotify " + val);
                abort();
                return;
            }
            var availidx = (this.ramdev.ReadMemory16(this.availaddr + 2)-1) & (this.queuenum-1);
            val = this.ramdev.ReadMemory16(this.availaddr + 4 + (availidx)*2);
            //DebugMessage("write to index : " + hex8(val) + " availidx:" + availidx);

            var currentindex = val;
            // build stream function
            var offset = 0;
            this.desc = this.GetDescriptor(currentindex);
            //DebugMessage(this.desc.addr);
            //DebugMessage("consume written " + currentindex + " " + this.desc.len);
            
            this.GetByte = function() {
                if (offset >= this.desc.len) {
                    offset = 0;
                    if (this.desc.flags & 1) { // continuing buffer
                        this.desc = this.GetDescriptor(this.desc.next);
                    } else {
                        DebugMessage("Error in virtiodev: Descriptor is not continuing");
                        abort();
                    }
                }
                var x = this.ramdev.ReadMemory8(this.desc.addr+offset);
                offset++;
                return x;
            }.bind(this);

            this.dev.ReceiveRequest(currentindex, this.GetByte);
            break;

        case VIRTIO_INTERRUPTACK_REG:
            //DebugMessage("write interruptack reg : " + hex8(val));
            this.intstatus &= ~val;
            this.intdev.ClearInterrupt(0x6);
            break;

        default:
            DebugMessage("Error in VirtIODev: Attempt to write register " + hex8(addr) + ":" + hex8(val));
            abort();
            break;
    }

};
