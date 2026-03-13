#!/bin/bash
# Flag processing function with namespacing and global variable declaration
UTILS_FILE_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    # echo "In macOS utils sed START"
    # echo "UTILS_ABSPATH: $UTILS_FILE_ABSPATH"
    sed -i '' 's/\r//g' "$UTILS_FILE_ABSPATH"
    # echo "In macOS utils sed END"
else
    # echo "NOT in macOS utils START"
    # echo "UTILS_ABSPATH: $UTILS_FILE_ABSPATH"
    sed -i 's/\r//g' "$UTILS_FILE_ABSPATH"
    # echo "NOT in macOS utils END"
fi
chmod +x "$UTILS_FILE_ABSPATH"

RUN_DIR_ABSPATH="$(dirname "$UTILS_FILE_ABSPATH")"
FRONTEND_DIR_ABSPATH="$(dirname "$RUN_DIR_ABSPATH")"

formatted_error() {
    # Arguments: error message and array of conflicting flags
    local initial_message="$1"
    shift
    local conflicting_flags=("$@")

    # Red color for the error message box
    local COLOR_CODE='\033[0;31m'
    local NC='\033[0m' # No Color

    # Start the error message with the initial message
    local error_message="$initial_message"
    
    # Add each conflicting flag on a new line with indentation
    for conflict in "${conflicting_flags[@]}"; do
        error_message+="\n    $conflict"   # Replacing `\t` with four spaces
    done

    # Prepare for printing by finding max length of each line in the message
    local lines=()
    local max_length=0

    # Use printf to interpret new lines and calculate max length with spaces instead of tabs
    while IFS= read -r line; do
        # Substitute tabs with spaces for consistent width measurement
        local line_with_spaces="${line//$'\t'/    }"
        lines+=("$line_with_spaces")
        if (( ${#line_with_spaces} > max_length )); then
            max_length=${#line_with_spaces}
        fi
    done <<< "$(printf "$error_message")"

    # Create the top and bottom borders based on the maximum line length
    local border=$(printf '%*s' "$((max_length + 4))" '' | tr ' ' '-')

    # Print the formatted error message with a red box
    printf "\n${COLOR_CODE}%s${NC}\n" "$border"
    for line in "${lines[@]}"; do
        printf "${COLOR_CODE}| %-*s |${NC}\n" "$max_length" "$line"
    done
    printf "${COLOR_CODE}| %-*s |${NC}\n" "$max_length" ""
    printf "${COLOR_CODE}%s${NC}\n" "$border"
}


function process_flags() {
    local -n flags_to_commands="$1"    # Reference to the dictionary of flags and commands
    local -n exclusives="$2"           # Reference to the list of exclusive flag groups
    local namespace="$3"               # Unique prefix for variables
    local calling_script_name="$(basename "$(readlink -f "${BASH_SOURCE[1]}")")"
    local caller_id="${FUNCNAME[1]}"
    local should_exit=false
    if [ "$caller_id" == "main" ]; then
        caller_id="$calling_script_name"
    fi
    # echo "caller_id: $caller_id"
    # echo "Initializing flags with namespace: $namespace"
    
    # Initialize flag variables with namespacing in the sourcing script context
    for flag in "${!flags_to_commands[@]}"; do
        # Convert flag to uppercase variable name and apply namespace, e.g., MYAPP_FLAG1
        local flag_var="${namespace}_${flag^^}"   # Prefix and uppercase
        flag_var="${flag_var//-}"                 # Remove dashes
        eval "declare -g $flag_var=false"         # Initialize as global false
        
        # Diagnostic output for each initialized variable
        # echo "Initialized $flag_var as false"
    done

    # echo "Parsing command line arguments: $@"
    
    # Parse command line arguments and set flags
    local unsupported_flags=()
    # local potential_typos=()
    for arg in "$@"; do
        # echo "Processing argument: $arg"
        if [[ -n "${flags_to_commands[$arg]}" ]]; then
            # echo "Flag found: $arg"
            local flag_var="${namespace}_${arg^^}" # Prefix and uppercase
            flag_var="${flag_var//-}"              # Remove dashes
            eval "declare -g $flag_var=true"       # Set as global true
            # echo "Set $flag_var to true"
            # echo "Executing command for $arg: ${flags_to_commands[$arg]}"
            eval "${flags_to_commands[$arg]}"
        else
            if [[ "$arg" == "-"* ]]; then
                # echo "Flag not found: $arg"
                unsupported_flags+=("$arg")
                if [[ -n "${flags_to_commands[-$arg]}" ]]; then
                    # echo "Potential typo: $arg"
                    unsupported_flags+=("\t*Note: Potential typo detected.")
                    unsupported_flags+=("\tDid you mean: -$arg")
                fi
            fi
        fi
    done
    # Check exclusive flag groups for conflicts
    # echo "Checking exclusive flag groups"
    for group in "${exclusives[@]}"; do
        local count=0
        local conflicting_flags=()
        for flag in $group; do
            local flag_var="${namespace}_${flag^^}"
            flag_var="${flag_var//-}"
            if [[ "$(eval echo "\$$flag_var")" == "true" ]]; then
                conflicting_flags+=("$flag")
                # count=$((count + 1))
                # ec "$flag_var is true in exclusive group"
            fi
        done
        if (( ${#conflicting_flags[@]} > 1 )); then
            # echo "found conflicting flags"
            formatted_error "Error: $caller_id\n-----------------------------------------\nIncompatible flags:\nThe flags below cannot be used together\n-----------------------------------------\n" "${conflicting_flags[@]}"
            should_exit=true
        fi
    done
    # echo "should_exit: $should_exit"
    # echo "unsupported_flags: ${#unsupported_flags[@]}"
    if (( ${#unsupported_flags[@]} > 0 )); then
        # echo "found unsupported flags 2"
        formatted_error "Error: $caller_id\n-------------------------------------------------\nUnsupported flags:\nThe flags below are not supported by this script\n-------------------------------------------------\n" "${unsupported_flags[@]}"
        should_exit=true
    fi
    if [[ $should_exit == true ]]; then
        exit 1
    fi
}



formatted_echo() {
    local COLOR_CODE='\033[0m' # No Color
    local NC='\033[0m'         # No Color variable
    # local message="$2"
    # If the second argument is empty, then theres no color specified, so we use the first argument as the message
    if [[ -z "$2" ]]; then
        message="$1"
    else
        message="$2"
    fi

    declare -A format_flags
    format_flags=(
        [--red]="COLOR_CODE='\033[0;31m'"
        [--green]="COLOR_CODE='\033[0;32m'"
        [--yellow]="COLOR_CODE='\033[0;33m'"
        [--blue]="COLOR_CODE='\033[0;34m'"
        [--purple]="COLOR_CODE='\033[0;35m'"
        [--cyan]="COLOR_CODE='\033[0;36m'"
    )
    exclusive_format_flags=(
        "--red --green --yellow --blue --purple --cyan"
    )

    # Pass the arguments with the namespace "FORMAT"
    process_flags format_flags exclusive_format_flags "FORMAT" "$@"

    # Process the message
    local text
    text=$(printf "%b" "$message")
    
    # Expand any escaped characters in the input (e.g., \n)
    local lines=()
    local max_length=0

    # Read the text line by line and find the maximum length
    while IFS= read -r line; do
        lines+=("$line")
        if (( ${#line} > max_length )); then
            max_length=${#line}
        fi
    done <<< "$text"

    # Create the top and bottom borders based on the maximum line length
    local border=$(printf '%*s' "$((max_length + 4))" '' | tr ' ' '-')
    
    # Print the formatted box with selected color
    printf "\n${COLOR_CODE}%s${NC}\n" "$border"
    for line in "${lines[@]}"; do
        printf "${COLOR_CODE}| %-*s |${NC}\n" "$max_length" "$line"
    done
    printf "${COLOR_CODE}%s${NC}\n" "$border"
}