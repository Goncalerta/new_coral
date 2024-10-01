import { Joinpoint } from "@specs-feup/clava/api/Joinpoints.js";
import AddAssignmentsToCallsAndBorrows from "coral/normalize/pass/AddAssignmentsToCallsAndBorrows";
import SimplifyAssignments from "coral/normalize/pass/SimplifyAssignments";
import SplitExpressions from "coral/normalize/pass/SplitExpressions";
import SplitVarDecls from "coral/normalize/pass/SplitVarDecls";
import ConvertForLoopToWhile from "coral/normalize/pass/ConvertForLoopToWhile";
import Query from "@specs-feup/lara/api/weaver/Query.js";

// TODO:
//       [] into *(+)
class CoralNormalizer {
    tempVarCounter: number;
    labelCounter: number;

    constructor(
        tempVarCounter: number = 0,
        labelCounter: number = 0,
    ) {
        this.tempVarCounter = tempVarCounter;
        this.labelCounter = labelCounter;
    }

    apply($jp: Joinpoint): this {
        return this
            .#applyPass($jp, new ConvertForLoopToWhile(this.labelCounter))
            .#applyPass($jp, new SplitVarDecls())
            .#applyPass($jp, new SimplifyAssignments())
            .#applyPass($jp, new AddAssignmentsToCallsAndBorrows(this.tempVarCounter))
            .#applyPass($jp, new SplitExpressions(this.tempVarCounter));
    }

    #applyPass($jp: Joinpoint, pass: CoralNormalizer.Pass): this {
        for (const $fn of Query.searchFromInclusive($jp, "function")) {
            pass.apply($fn as Joinpoint);    
        }
        
        if (pass.tempVarCounter !== undefined) {
            this.tempVarCounter = pass.tempVarCounter;
        }
        if (pass.labelCounter !== undefined) {
            this.labelCounter = pass.labelCounter;
        }

        return this;
    }
}

namespace CoralNormalizer {
    export interface Pass {
        apply($jp: Joinpoint): void;
        tempVarCounter?: number;
        labelCounter?: number;
    }
}

export default CoralNormalizer;
